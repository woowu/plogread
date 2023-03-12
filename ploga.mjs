#!/usr/bin/node --harmony

import { tmpdir } from 'node:os';
import path from 'node:path';
import { exec } from 'node:child_process';
import crypto from 'node:crypto';
import readline from 'node:readline';
import yargs from 'yargs/yargs';
import fs from 'node:fs';

const TICK_START_VALUE = 0xfffc0000;
var verbose = false;

/*===========================================================================*/

function parseTimeAndTick(logLine)
{
    const words = logLine.split(/\s+/);
    const time = new Date(words[0]);
    const tick = parseInt(parseFloat(words[1]) * 1000);

    return {
        time,
        tick,
        message: logLine.slice(logLine.search(words[1]) + words[1].length)
            .trim()
    };
}

function tickDiff(from, to)
{
    const mod = 2**32;
    return (to + (mod - from)) % mod;
}

function tickToTimeOffset(tick)
{
    const offset = tickDiff(0xfffc0000, tick);
    return (offset/1000).toFixed(3);
}

/*===========================================================================*/

function UbiTimeCalc() {
    this._stopUbiStarted = null;
    this._stopUbiStopped = null;
}

UbiTimeCalc.prototype.putLine = function(time, tick, message, lno) {
    if (! this._stopUbiStarted && message.search('stop file reader/writer') >= 0) {
        this._stopUbiStarted = { time, tick, lno };
        return;
    }
    if (this._stopUbiStarted && message.search('stop flash') >= 0) {
        this._stopUbiStopped = { time, tick, lno };
        return;
    }
};

UbiTimeCalc.prototype.getStopUbiDuration = function() {
    if (! this._stopUbiStarted && ! this._stopUbiStopped)
        return 0;
    if (this._stopUbiStarted && ! this._stopUbiStopped)
        throw new Error('UBI stop not finished?');
    return tickDiff(this._stopUbiStarted.tick, this._stopUbiStopped.tick);
};

/*===========================================================================*/

function PscmWaitStart(machine)
{
    this.name = 'wait-start';
    this._machine = machine;
}

function SystemStart(machine, time, tick, lno, coldStart)
{
    this.name = 'system-start';
    this._time = time;
    this._tick = tick;
    this._lno = lno;
    this._machine = machine;
    this._machine.sendEvent( { name: 'start', time, tick, lno });
    this._machine.setSystemStarted();
    this._machine.setColdStart(coldStart);
}

function PscmWakeup(machine, time, tick, lno)
{
    this.name = 'wakeup';
    this._time = time;
    this._tick = tick;
    this._lno = lno;
    this._machine = machine;
    this._machine.sendEvent({ name: 'wakeup', time, tick, lno });
}

function PscmOnMains(machine, time, tick, lno)
{
    this.name = 'on-mains';
    this._time = time;
    this._tick = tick;
    this._lno = lno;
    this._machine = machine;
    this._machine.sendEvent({ name: 'on-mains', time, tick, lno });
}

function PscmInfrReady(machine, time, tick, lno)
{
    this.name = 'infr-ready';
    this._time = time;
    this._tick = tick;
    this._lno = lno;
    this._machine = machine;
    this._machine.sendEvent({ name: 'infr-ready', time, tick, lno });
}

function PscmNormalOpr(machine, time, tick, lno)
{
    this.name = 'normal-opr';
    this._time = time;
    this._tick = tick;
    this._lno = lno;
    this._machine = machine;
    this._machine.sendEvent({ name: 'normal-opr', time, tick, lno });
}

function PscmWaitReset(machine, time, tick, lno)
{
    this.name = 'wait-reset';
    this._time = time;
    this._tick = tick;
    this._lno = lno;
    this._machine = machine;
    this._machine.sendEvent({ name: 'wait-reset', time, tick, lno });
}

PscmWaitStart.prototype.putLine = function(time, tick, message, lno) {
    const m = message.match(/system started.*coldStart ([01])/);
    if (! m) return;

    this._machine.setPscmState(new SystemStart(this._machine
        , time, tick, lno, m[1] == '1'));
};

SystemStart.prototype.putLine = function(time, tick, message, lno) {
    if (message.search('enter psm wakeup') < 0) return;
    this._machine.setPscmState(new PscmWakeup(this._machine, time, tick, lno));
};

PscmWakeup.prototype.putLine = function(time, tick, message, lno) {
    if (message.search('enter psm on-mains') < 0) return;
    this._machine.setPscmState(new PscmOnMains(this._machine, time, tick, lno));
}

PscmOnMains.prototype.putLine = function(time, tick, message, lno) {
    const toReset = message.search('enter psm wait-for-reset') >= 0;
    const toInfr = message.search('enter psm infr-ready') >= 0;

    if (! toReset && ! toInfr) return;

    this._machine.setPscmState(
        toInfr ? new PscmInfrReady(this._machine, time, tick, lno)
        : new PscmWaitReset(this._machine, time, tick, lno)
    );
}

PscmInfrReady.prototype.putLine = function(time, tick, message, lno) {
    const toReset = message.search('enter psm wait-for-reset') >= 0;
    const toNormal = message.search('enter psm normal-operation') >= 0;

    if (! toReset && ! toNormal) return;

    this._machine.setPscmState(
        toNormal ? new PscmNormalOpr(this._machine, time, tick, lno)
        : new PscmWaitReset(this._machine, time, tick, lno)
    );
}

PscmNormalOpr.prototype.putLine = function(time, tick, message, lno) {
    if (message.search('enter psm wait-for-reset') < 0) return;
    this._machine.setPscmState(new PscmWaitReset(this._machine, time, tick, lno));
}

PscmWaitReset.prototype.onEnter = function() {
    this._machine.completePowerCycle();
};

/*===========================================================================*/

const detectPowerSupplyEvent = function(message) {
    const regexp = /PSCm (send|dispatch) event (Power\w+)/;
    const m = message.match(regexp);
    return { action: m ? m[1] : null, event: m ? m[2] : null };
};

function PsUnknown(machine, time, tick, lno)
{
    this.name = 'ps-unknown';
    this._time = time;
    this._tick = tick;
    this._lno = lno;
    this._machine = machine;
}

function PsAboveStartup(machine, time, tick, lno)
{
    this.name = 'ps-above-startup';
    this._time = time;
    this._tick = tick;
    this._lno = lno;
    this._machine = machine;
    this._histLog = [];
}

function PsBelowPowersave(machine, time, tick, lno)
{
    this.name = 'ps-below-powersave';
    this._time = time;
    this._tick = tick;
    this._lno = lno;
    this._machine = machine;

    this._machine.setPowerDownFiredEvent({ time, tick, lno });
}

function PsBelowShutdown(machine, time, tick, lno)
{
    this.name = 'ps-below-shutdown';
    this._time = time;
    this._tick = tick;
    this._lno = lno;
    this._machine = machine;
}

PsUnknown.prototype.putLine = function(time, tick, message, lno) {
    const { action, event } = detectPowerSupplyEvent(message);

    if (action != 'send') return;

    if (event == 'PowerAboveStartupLevel') {
        this._machine.setPsState(new PsAboveStartup(this._machine, time, tick, lno));
    } else {
        console.error(time, tick, message);
        throw new Error(`lost power supply message in ${this.name} state. got ${event}`);
    }
}

PsAboveStartup.prototype.putLine = function(time, tick, message, lno) {
    this._histLog.push({ time, tick, message, lno });
    const { action, event } = detectPowerSupplyEvent(message);

    if (action != 'send') return;
    
    if (event != 'PowerBelowPowersaveLevel') {
        console.error(time, tick, message);
        throw new Error(`lost power supply message in ${this.name} state. got ${event}`);
    }

    var powerDownTime = null;
    for (var i = this._histLog.length - 1; i >= 0; --i) {
        if (this._histLog[i].message.search(
            'power supply state switch: Normal -> FilteringTime') >= 0) {
            powerDownTime = {
                time: this._histLog[i].time,
                tick: this._histLog[i].tick,
            };
        }
    }
    if (! powerDownTime)
        throw new Error('no power supply filter log found');

    this._machine.setPsState(new PsBelowPowersave(this._machine
        , powerDownTime.time, powerDownTime.tick, lno));
}

PsBelowPowersave.prototype.putLine = function(time, tick, message, lno) {
    const { action, event } = detectPowerSupplyEvent(message);

    if (action == 'dispatch' && event == 'PowerBelowPowersaveLevel') {
        this._machine.setPowerDownDispatchedEvent({ time, tick, lno });
        return;
    }

    if (action != 'send') return;
    
    if (event == 'PowerBelowShutdownLevel')
        this._machine.setPsState(new PsBelowShutdown(this._machine, time, tick, lno));
    else if (event == 'PowerAboveStartupLevel')
        this._machine.setPsState(new PsAboveStartup(this._machine, time, tick, lno));
    else {
        console.error(time, tick, message);
        throw new Error(`lost power supply message in ${this.name} state. got ${event}`);
    }
}

PsBelowShutdown.prototype.putLine = function(time, tick, message, lno) {
    const { action, event } = detectPowerSupplyEvent(message);

    if (action == 'dispatch' && event == 'PowerBelowPowersaveLevel') {
        this._machine.setPowerDownDispatchedEvent({ time, tick, lno });
        return;
    }

    if (action == 'send' && event == 'PowerAboveStartupLevel')
        this._machine.setPsState(new PsAboveStartup(this._machine, time, tick, lno));
}

/*===========================================================================*/

function LogParser(csvOutStream)
{
    this._lno = 0;
    this._maxLines = 0;
    this._nPowerCycles = 0;
    this._csv = csvOutStream;

    this._renewPowerCycle();
}

LogParser.prototype._renewPowerCycle = function() {
    this._pscmState = new PscmWaitStart(this);
    this._psState = new PsUnknown(this);
    this._coldStart = false;

    this._powerCycle = { events: [] };

    /* When this is false, the log message is incompleted, should
     * not use them to report errors.
     */
    this._systemStarted = false;

    this._powerDownFiredEvent = null;
    this._powerDownDispatchedEvent = null;

    this._ubiTimeCalc = new UbiTimeCalc();
}

LogParser.prototype.setPscmState = function(s) {
    console.log(`${s._lno}: pscm state trans: ${this._pscmState.name} -> ${s.name}`);
    this._pscmState = s;
    if (s.onEnter) s.onEnter();
};

LogParser.prototype.setPsState = function(s) {
    console.log(`${s._lno}: ps state trans: ${this._psState.name} -> ${s.name}`);
    this._psState = s;
};

LogParser.prototype.putLine = function(line) {
    if (this._maxLines && this._lno == this._maxLines)
        return;
    ++this._lno;
    line = line.trim();
    if (! line) return;
    if (line.search('bad format') >= 0) return;

    const { time, tick, message } = parseTimeAndTick(line);
    this._pscmState.putLine(time, tick, message, this._lno);

    if (this.getSystemStarted()) {
        this._psState.putLine(time, tick, message, this._lno);
        this._ubiTimeCalc.putLine(time, tick, message, this._lno);
    }
};

LogParser.prototype.sendEvent = function(e) {
    this._powerCycle.events.push(e);
};

LogParser.prototype.setSystemStarted = function(s) {
    this._systemStarted = true;
};

LogParser.prototype.getSystemStarted = function() {
    return this._systemStarted;
};

LogParser.prototype.completePowerCycle = function() {
    /* When a PSCM state peaks into the power supply state,
     * the below-power-save event may not be received from
     * the queue.
     */
    if (! this._powerDownDispatchedEvent)
        this._powerDownDispatchedEvent
            = this._powerDownFiredEvent;

    if (! this._nPowerCycles)
        this._csv.write('No,PowerCycleLnoFrom,PowerCycleLnoTo,'
            + 'WakeupTime,ResetTime,'
            + 'PowerDownStartTime,PowerDownDispatchedTime,CapacitorTime,'
            + 'StateWhenPowerDownDetected,StateWhenPowerDownDispatched,'
            + 'UbiStopTime\n'
        );

    /* because there is the filter time, so the actual power down time is
     * earlier than the time the power supply supervisor sent below-pwersave
     * message.
     */
    var tickFrom = null;
    for (const e of this._powerCycle.events) {
        if (e.name == 'wakeup') {
            tickFrom = e.tick;
            break;
        }
    }
    if (tickFrom === null) throw new Error('no wakeup');
    const tickTo = this._powerCycle.events.slice(-1)[0].tick;

    if (! this._coldStart)
        this._csv.write(`${this._nPowerCycles + 1},`
            + `${this._powerCycle.events[0].lno},`
            + `${this._powerCycle.events.slice(-1)[0].lno},`
            + `${tickToTimeOffset(tickFrom)},`
            + `${tickToTimeOffset(tickTo)},`
            + `${tickToTimeOffset(this._powerDownFiredEvent.tick)},`
            + `${tickToTimeOffset(this._powerDownDispatchedEvent.tick)},`
            + `${tickDiff(this._powerDownFiredEvent.tick, tickTo)/1000 .toFixed(3)},`
            + `${this._powerDownFiredEvent.pscm},`
            + `${this._powerDownDispatchedEvent.pscm},`
            + `${this._ubiTimeCalc.getStopUbiDuration()/1000 .toFixed(3)}\n`
        );

    ++this._nPowerCycles;
    if (verbose) console.log(`power cycle #${this._nPowerCycles} end`);
    this._renewPowerCycle();
};

LogParser.prototype.setMaxLines = function(n) {
    this._maxLines = n;
};

LogParser.prototype.setPowerDownFiredEvent = function({ time, tick, lno }) {
    this._powerDownFiredEvent = { time, tick, lno, pscm: this._pscmState.name };
};

LogParser.prototype.clearPowerDownFiredEvent = function() {
    this._powerDownFiredEvent = null;
};

LogParser.prototype.setPowerDownDispatchedEvent = function({ time, tick, lno }) {
    this._powerDownDispatchedEvent = { time, tick, lno, pscm: this._pscmState.name };
};

LogParser.prototype.setColdStart = function(coldStart) {
    this._coldStart = coldStart;
};

function stat(argv)
{
    const dataName = 'stat';
    const rl = readline.createInterface({ input: fs.createReadStream(argv.file) });
    const csvStream = fs.createWriteStream(`${dataName}.csv`);
    const parser = new LogParser(csvStream);
    if (argv.maxLines !== undefined) parser.setMaxLines(argv.maxLines);

    verbose = argv.verbose;

    rl.on('line', line => {
        parser.putLine(line);
    });
    rl.on('close', () => {
        csvStream.end();
        console.log(`saved ${dataName}.csv`);
        exec(`Rscript ${argv.plot} --csv ${dataName}.csv --out ${dataName}.png`
            , (err, stdout, stderr) => {
                if (err) throw new Error(err);
                console.log(`saved stat.png`);
            });
    });
}

/*===========================================================================*/

const argv = yargs(process.argv.slice(2))
    .option('f', {
        alias: 'file',
        describe: 'log filename', 
        nargs: 1,
        demandOption: true,
        type: 'string',
       }
    )
    .option('m', {
        alias: 'max-lines',
        describe: 'max number of lines to read from the log', 
        nargs: 1,
        type: 'number',
       }
    )
    .option('V', {
        alias: 'verbose',
        describe: 'print debug info', 
        type: 'boolean',
       }
    )
    .command('stat', 'statistics', yargs => {
            yargs.option('plot', {
                alias: 'p',
                describe: 'R script filename for plotting',
                nargs: 1,
                type: 'string',
            });
        },
        stat,
    )
    .argv;
