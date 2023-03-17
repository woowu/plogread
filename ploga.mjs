#!/usr/bin/node --harmony

import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import util from 'node:util';
import path from 'node:path';
import { exec } from 'node:child_process';
import crypto from 'node:crypto';
import readline from 'node:readline';
import yargs from 'yargs/yargs';
import fs from 'node:fs';
import moment from 'moment';

const execp = util.promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const statScript = path.join(__dirname, 'bin', 'stat');

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
    var n = (to + (mod - from)) % mod;
    if (n > 2**31) n -= mod;
    return n;
}

/* Convert device RTOS tick time to time offset since the device started 
 */
function tickToTimeOffset(tick)
{
    const START_TICK = 0xfffc0000;
    const offset = tickDiff(START_TICK, tick);
    return (offset/1000).toFixed(3);
}

/*===========================================================================*/

function NormalOprStartupTimeCalc() {
    this._begin = null;
    this._end = null;
}

NormalOprStartupTimeCalc.prototype.putLine = function(time, tick, message, lno) {
    if (! this._begin && message.search('enter psm normal-operation') >= 0) {
        this._begin = { time, tick, lno };
        return;
    }
    if (this._begin && ! this._end && (message.search(' handle PowerAbove') >= 0
        || message.search(' handle PowerBelow') >= 0)) {
        this._end = { time, tick, lno };
        return;
    }
};

NormalOprStartupTimeCalc.prototype.getDuration = function() {
    if (! this._begin && ! this._end)
        return 0;
    if (this._begin && ! this._end)
        throw new Error('normal-opr startup not finished?');
    return tickDiff(this._begin.tick, this._end.tick);
};

/*===========================================================================*/

function UbiStartTimeCalc() {
    this._begin = null;
    this._end = null;
}

UbiStartTimeCalc.prototype.putLine = function(time, tick, message, lno) {
    if (this._begin && ! this._end && message.search('start UBI: done') >= 0) {
        this._end = { time, tick, lno };
        return;
    }
    if (! this._begin && message.search('start UBI') >= 0) {
        this._begin = { time, tick, lno };
        return;
    }
};

UbiStartTimeCalc.prototype.getDuration = function() {
    if (! this._begin && ! this._end)
        return 0;
    if (this._begin && ! this._end)
        throw new Error('UBI start not finished?');
    return tickDiff(this._begin.tick, this._end.tick);
};

/*===========================================================================*/

function UbiStopTimeCalc() {
    this._begin = null;
    this._end = null;
}

UbiStopTimeCalc.prototype.putLine = function(time, tick, message, lno) {
    if (! this._begin && message.search('stop file reader/writer') >= 0) {
        this._begin = { time, tick, lno };
        return;
    }
    if (this._begin && ! this._end && message.search('stop flash') >= 0) {
        this._end = { time, tick, lno };
        return;
    }
};

UbiStopTimeCalc.prototype.getDuration = function() {
    if (! this._begin && ! this._end)
        return 0;
    if (this._begin && ! this._end)
        throw new Error('UBI stop not finished?');
    return tickDiff(this._begin.tick, this._end.tick);
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

    if (action == 'send' && event == 'PowerAboveStartupLevel')
        this._machine.setPsState(new PsAboveStartup(this._machine, time, tick, lno));
}

/*===========================================================================*/

function PowerDownDispatchTimeDetector(machine)
{
    this.dispatchEvent = null;
    this._machine = machine;
}

PowerDownDispatchTimeDetector.prototype.putLine = function(time, tick, message, lno) {
    const fireEvent = this._machine.getPowerDownFiredEvent();
    if (! fireEvent) return;
    if (this.dispatchEvent && tickDiff(fireEvent.tick, this.dispatchEvent.tick) >= 0) return;

    const { action, event } = detectPowerSupplyEvent(message);

    /* When a PSCM state peaks into the power supply state, the
     * below-power-save event may not be dispatched, but we can get the clue
     * from the PSCM said it started to handle the powersave or power down
     * situation.
     */
    if (message.search('handle PowerBelow') >= 0) {
        this.dispatchEvent = {
            time,
            tick,
            lno,
            pscm: this._machine.getPscmState().name,
        };
        return;
    }

    if (action == 'dispatch' && event == 'PowerBelowPowersaveLevel') {
        this.dispatchEvent = {
            time,
            tick,
            lno,
            pscm: this._machine.getPscmState().name,
        };
        return;
    }
}

/*===========================================================================*/
function BackupTimeCalc(machine)
{
    this._machine = machine;
    this.start = null;
    this.end = null;
}

BackupTimeCalc.prototype.putLine = function(time, tick, message, lno) {
    if (message.search(/StartupTask.*start shutdown/) >= 0) {
        this.start = { time, tick, lno };
        return;
    }
    if (message.search(/StartupTask.*backup: done/) >= 0) {
        if (! this.start) throw new Error('missed start-shutdown');
        this.end = { time, tick, lno };
        return;
    }
    /* backup was skipeed */
    if (! this.end && message.search(/StartupTask.*shutdown done/) >= 0) {
        this.end = { time, tick, lno };
        return;
    }
};

/*===========================================================================*/

function LogParser(csvOutStream, ignoreList)
{
    this._lno = 0;
    this._maxLines = 0;
    this._nPowerCycles = 0;
    this._csv = csvOutStream;
    this._ignoreList = ignoreList;

    this._renewPowerCycle();
}

LogParser.prototype._renewPowerCycle = function() {
    this._pscmState = new PscmWaitStart(this);
    this._psState = new PsUnknown(this);
    this._powerDownDispatchTimeDetector = new PowerDownDispatchTimeDetector(this);
    this._backupTimeCalc = new BackupTimeCalc(this);

    this._coldStart = false;
    this._powerCycle = { events: [] };

    /* When this is false, the log message is incompleted, should
     * not use them to report errors.
     */
    this._systemStarted = false;

    this._powerDownFiredEvent = null;
    this._powerDownDispatchEvent = null;
    this._backupStartEvent = null;
    this._backupEndEvent = null;

    this._ubiStopTimeCalc = new UbiStopTimeCalc();
    this._ubiStartTimeCalc = new UbiStartTimeCalc();
    this._normalOprStartupTimeCalc = new NormalOprStartupTimeCalc();
}

LogParser.prototype.setPscmState = function(s) {
    console.log(`${s._lno}: ${tickToTimeOffset(s._tick)}`
        + ` pscm trans: ${this._pscmState.name} -> ${s.name}`);
    this._pscmState = s;
    if (s.onEnter) s.onEnter();
};

LogParser.prototype.getPscmState = function() {
    return this._pscmState;
};

LogParser.prototype.setPsState = function(s) {
    console.log(`${s._lno}: ${tickToTimeOffset(s._tick)}`
        + ` ps trans: ${this._psState.name} -> ${s.name}`);
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
        this._ubiStartTimeCalc.putLine(time, tick, message, this._lno);
        this._ubiStopTimeCalc.putLine(time, tick, message, this._lno);
        this._normalOprStartupTimeCalc.putLine(time, tick, message, this._lno);
        this._powerDownDispatchTimeDetector.putLine(time, tick, message, this._lno);
        this._backupTimeCalc.putLine(time, tick, message, this._lno);
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
    if (this._ignoreList.includes(this._nPowerCycles + 1)) {
        console.log(`ignored power cycle #${this._nPowerCycles + 1}`);
        ++this._nPowerCycles;
        this._renewPowerCycle();
        return;
    }

    if (! this._powerDownDispatchTimeDetector.dispatchEvent) {
        /* This happened when the on-mains state detected the power has down.
         * There are still as short resp delay, but no log message can be used
         * to detect that.
         */
        console.log('warn: no power down dispatch/handling message found');
        this._powerDownDispatchEvent = this._powerDownFiredEvent;
    } else
        this._powerDownDispatchEvent = this._powerDownDispatchTimeDetector
            .dispatchEvent;

    if (this._backupTimeCalc.start && ! this._backupTimeCalc.end)
        throw new Error('incompleted backup');
    this._backupStartEvent = this._backupTimeCalc.start;
    this._backupEndEvent = this._backupTimeCalc.end;

    this._outputCurrPowerCycle();

    ++this._nPowerCycles;
    this._renewPowerCycle();
};

LogParser.prototype._outputCurrPowerCycle = function() {
    var tickFrom = null;
    var timeFrom = null;
    for (const e of this._powerCycle.events) {
        if (e.name == 'wakeup') {
            tickFrom = e.tick;
            timeFrom = e.time;
            break;
        }
    }
    if (tickFrom === null) throw new Error('no wakeup');
    const tickTo = this._powerCycle.events.slice(-1)[0].tick;

    console.log(`power cycle #${this._nPowerCycles + 1} end.`
        + ' capacitor time'
        + ` ${tickDiff(this._powerDownFiredEvent.tick, tickTo)/1000 .toFixed(3)}s`
        + ' shutdown time'
        + ` ${tickDiff(this._powerDownDispatchEvent.tick, tickTo)/1000 .toFixed(3)}s`
    );

    if (! this._csv) return;

    var backupTime = 0;
    if (this._backupStartEvent)
        backupTime = tickDiff(this._backupStartEvent.tick, this._backupEndEvent.tick);

    if (! this._nPowerCycles)
        this._csv.write('No,LnoFrom,LnoTo,'
            + 'WakeupRealTime,WakeupMiliSecs,'
            + 'PowerDownRealTime,PdMiliSecs,'
            + 'WakeupTime,ResetTime,'
            + 'PdStartTime,PdDispatchTime,'
            + 'CapacitorTime,ShutdownTime,BackupTime,'
            + 'UbiStartTime,UbiStopTime,NormalStartupTime,'
            + 'RespDelay,'
            + 'PdDetectedState,PdDispatchedState\n'
        );

    if (! this._coldStart)
        this._csv.write(`${this._nPowerCycles + 1},`
            + `${this._powerCycle.events[0].lno},`
            + `${this._powerCycle.events.slice(-1)[0].lno},`
            + `${moment(timeFrom).format('YYYY-MM-DDTHH:mm:ss.SSSZ')},`
            + `${timeFrom.valueOf()},`
            + `${moment(this._powerDownFiredEvent.time).format('YYYY-MM-DDTHH:mm:ss.SSSZ')},`
            + `${this._powerDownFiredEvent.time.valueOf()},`

            + `${tickToTimeOffset(tickFrom)},`
            + `${tickToTimeOffset(tickTo)},`
            + `${tickToTimeOffset(this._powerDownFiredEvent.tick)},`
            + `${tickToTimeOffset(this._powerDownDispatchEvent.tick)},`
            + `${tickDiff(this._powerDownFiredEvent.tick, tickTo)/1000 .toFixed(3)},`
            + `${tickDiff(this._powerDownDispatchEvent.tick, tickTo)/1000 .toFixed(3)},`
            + `${backupTime/1000 .toFixed(3)},`
            + `${this._ubiStartTimeCalc.getDuration()/1000 .toFixed(3)},`
            + `${this._ubiStopTimeCalc.getDuration()/1000 .toFixed(3)},`
            + `${this._normalOprStartupTimeCalc.getDuration()/1000 .toFixed(3)},`
            + `${tickDiff(this._powerDownFiredEvent.tick, this._powerDownDispatchEvent.tick)/1000 .toFixed(3)},`
            + `${this._powerDownFiredEvent.pscm},`
            + `${this._powerDownDispatchEvent.pscm}\n`
        );
};

LogParser.prototype.setMaxLines = function(n) {
    this._maxLines = n;
};

LogParser.prototype.setPowerDownFiredEvent = function({ time, tick, lno }) {
    this._powerDownFiredEvent = { time, tick, lno, pscm: this._pscmState.name };
};

LogParser.prototype.clearPowerDownFiredEvent = function() {
    console.log('qqq');
    this._powerDownFiredEvent = null;
};

LogParser.prototype.getPowerDownFiredEvent = function() {
    return this._powerDownFiredEvent;
}

LogParser.prototype.setColdStart = function(coldStart) {
    this._coldStart = coldStart;
};

async function stat(argv)
{
    const dataName = argv.dataName;
    const ignoredPowerCycles = [];
    if (argv.ignore && ! Array.isArray(argv.ignore))
        ignoredPowerCycles.push(argv.ignore);
    else if (argv.ignore)
        ignoredPowerCycles.push(...argv.ignore);

    const rl = readline.createInterface({ input: fs.createReadStream(argv.file) });
    var csvStream;
    if (dataName)
        csvStream = fs.createWriteStream(`${dataName}.csv`);
    const parser = new LogParser(csvStream, ignoredPowerCycles);
    if (argv.maxLines !== undefined) parser.setMaxLines(argv.maxLines);

    verbose = argv.verbose;

    rl.on('line', line => {
        parser.putLine(line);
    });
    rl.on('close', async () => {
        if (! csvStream) return;

        csvStream.end();
        console.log(`saved ${dataName}.csv`);
        if (argv.noPlot) return;

        const cmdline = `${statScript} --dir ${process.cwd()} --data "${dataName}"`;
        console.log(cmdline);
        const { stdout, stderr } = await execp(cmdline);
        if (stderr) console.error(stderr);
        console.log(stdout);
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
            yargs.option('data-name', {
                alias: 'd',
                describe: 'dataset name used to create csv and plot files',
                nargs: 1,
                type: 'string',
                default: 'stat',
            });
            yargs.option('ignore', {
                alias: 'i',
                describe: 'ignore specified power cycle',
                nargs: 1,
                type: 'number',
            });
            yargs.option('no-plot', {
                alias: 'P',
                describe: 'not to plot',
                type: 'boolean',
            });
        },
        stat,
    )
    .argv;
