#!/usr/bin/node --harmony

import { tmpdir } from 'node:os';
import path from 'node:path';
import { exec } from 'node:child_process';
import crypto from 'node:crypto';
import readline from 'node:readline';
import yargs from 'yargs/yargs';
import fs from 'node:fs';

const TICK_START_VALUE = 0xfffc0000;

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

/*===========================================================================*/

function PscmWaitStart(machine)
{
    this.name = 'wait-start';
    this._machine = machine;
}

function SystemStart(machine, time, tick, lno, coldStart)
{
    this.name = 'system-start';
    this._machine = machine;
    this._machine.sendEvent( { name: 'start', time, tick, lno });
    this._machine.setSystemStarted();
}

function PscmNormalOpr(machine, time, tick, lno)
{
    this.name = 'normal-opr';
    this._machine = machine;
    this._machine.sendEvent({ name: 'normal-opr', time, tick, lno });
}

function Wakeup(machine, time, tick, lno)
{
    this.name = 'wakeup';
    this._machine = machine;
    this._machine.sendEvent({ name: 'wakeup', time, tick, lno });
}

function PscmOnMains(machine, time, tick, lno)
{
    this.name = 'on-mains';
    this._machine = machine;
    this._machine.sendEvent({ name: 'on-mains', time, tick, lno });
}

function PscmInfrReady(machine, time, tick, lno)
{
    this.name = 'infr-ready';
    this._machine = machine;
    this._machine.sendEvent({ name: 'infr-ready', time, tick, lno });
}

function PscmWaitReset(machine, time, tick, lno)
{
    this.name = 'wait-reset';
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
    this._machine.setPscmState(new Wakeup(this._machine), time, tick, lno);
};

Wakeup.prototype.putLine = function(time, tick, message, lno) {
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
    this._machine.setPscmState(new PscmWaitStart(this._machine));
};

/*===========================================================================*/

const detectPowerSupplyEvent = function(message) {
    const regexp = /PSCm (send|dispatch) event (Power\w+)/;
    const m = message.match(regexp);
    return { action: m ? m[1] : null, event: m ? m[2] : null };
};

function PsUnknown(machine)
{
    this.name = 'ps-unknown';
    this._machine = machine;
}

function PsAboveStartup(machine)
{
    this.name = 'ps-above-startup';
    this._machine = machine;
}

function PsBelowPowersave(machine, time, tick)
{
    this.name = 'ps-below-powersave';
    this._machine = machine;
    this._powerDownTime = { time, tick };
}

function PsBelowShutdown(machine)
{
    this.name = 'ps-below-shutdown';
    this._machine = machine;
}

PsUnknown.prototype.putLine = function(time, tick, message) {
    const { action, event } = detectPowerSupplyEvent(message);

    if (action != 'send') return;

    if (event == 'PowerAboveStartupLevel')
        this._machine.setPsState(new PsAboveStartup(this._machine, time, tick));
    else {
        console.error(time, tick, message);
        throw new Error(`lost power supply message in ${this.name} state. got ${event}`);
    }
}

PsAboveStartup.prototype.putLine = function(time, tick, message) {
    const { action, event } = detectPowerSupplyEvent(message);

    if (action != 'send') return;
    
    if (event == 'PowerBelowPowersaveLevel')
        this._machine.setPsState(new PsBelowPowersave(this._machine, time, tick));
    else {
        console.error(time, tick, message);
        throw new Error(`lost power supply message in ${this.name} state. got ${event}`);
    }
}

PsBelowPowersave.prototype.putLine = function(time, tick, message) {
    const { action, event } = detectPowerSupplyEvent(message);

    if (action != 'send') return;
    
    if (event == 'PowerBelowShutdownLevel') {
        this._machine.setPsState(new PsBelowShutdown(this._machine), time, tick);
        this._machine.setPowerDownTime(this._powerDownTime);
    } else if (event == 'PowerAboveStartupLevel')
        this._machine.setPsState(new PsAboveStartup(this._machine), time, tick);
    else {
        console.error(time, tick, message);
        throw new Error(`lost power supply message in ${this.name} state. got ${event}`);
    }
}

PsBelowShutdown.prototype.putLine = function(time, tick, message) {
    const { action, event } = detectPowerSupplyEvent(message);

    if (action == 'send' && event == 'PowerAboveStartupLevel')
        this._machine.setPsState(new PsAboveStartup(this._machine), time, tick);
}

/*===========================================================================*/

function LogParser()
{
    this._pscmState = new PscmWaitStart(this);
    this._psState = new PsUnknown(this);

    this._lineCount = 0;
    this._maxLines = 0;

    this._powerCycle = { events: [], currPscm: null };
    this._powerCycles = [];

    /* When this is false, the log message is incompleted, should
     * not use them to report errors.
     */
    this._systemStarted = true;
}

LogParser.prototype.setPscmState = function(s) {
    console.log(`pscm state trans: ${this._pscmState.name} -> ${s.name}`);
    this._pscmState = s;
    if (s.onEnter) s.onEnter();
};

LogParser.prototype.setPsState = function(s) {
    console.log(`ps state trans: ${this._psState.name} -> ${s.name}`);
    this._psState = s;
};

LogParser.prototype.putLine = function(line) {
    if (this._maxLines && this._lineCount == this._maxLines)
        return;
    ++this._lineCount;
    if (line.search('bad format') >= 0) return;

    const { time, tick, message } = parseTimeAndTick(line);
    this._pscmState.putLine(time, tick, message, this._lineCount);

    if (this.getSystemStarted())
        this._psState.putLine(time, tick, message);
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
    this._powerCycles.push(this._powerCycle);
    this._powerCycle = { events: [] };
};

LogParser.prototype.setMaxLines = function(n) {
    this._maxLines = n;
};

LogParser.prototype.setPowerDownTime = function({ time, tick }) {
    this._powerDownTime = { time, tick };
};

LogParser.prototype.report = function(datasetName, rScript) {
    console.log(`encountered ${this._powerCycles.length} power cycles:\n`);

    //const types = {};
    //for (const c of this._powerCycles) {
    //    if (types[c.lastPowerState] === undefined)
    //        types[c.lastPowerState] = [c];
    //    else
    //        types[c.lastPowerState].push(c);
    //}

    //for (const t in types) {
    //    const powerCycles = types[t];
    //    const powerDownMin = Math.min.apply(Math, powerCycles.map(o => o.powerDownDuration));
    //    const powerDownMax = Math.max.apply(Math, powerCycles.map(o => o.powerDownDuration));
    //    console.log(`  power down after ${t}: ${powerCycles.length};`
    //        + ` shutdown time min ${(powerDownMin / 1000).toFixed(3)}`
    //        + ` max ${(powerDownMax / 1000).toFixed(3)}`);
    //}

    //console.log('\n${this._invalidPowerCycles.length} Invalid power cycles:');
    //for (const c of this._invalidPowerCycles)
    //    console.log(`  [${c.lnoFirst}, ${c.lnoLast}]: ${c.line}`);

    //if (! rScript) return;

    //const tmpDir = tmpdir();
    //const csvName = path.join(tmpDir
    //    , `${crypto.randomBytes(6).readUIntBE(0, 6).toString(36)}.csv`);
    //const outputName = path.join(tmpDir, `${datasetName}.png`)
    //const os = fs.createWriteStream(csvName);
    //os.write('PowerDownStartTime,PowerDownUsedTime,StateWhenPowerDown\n');
    //for (const c of this._powerCycles) {
    //    var t = c.powerDownStartTime;
    //    if (t < TICK_START_VALUE)
    //        t += 2**32 - TICK_START_VALUE;
    //    else
    //        t -= TICK_START_VALUE;
    //    os.write(`${t/1000},${c.powerDownDuration/1000},${c.lastPowerState}\n`);
    //}
    //os.end();
    //exec(`Rscript ${rScript} --csv ${csvName} --out ${outputName}`
    //    , (err, stdout, stderr) => {
    //        if (err) throw new Error(err);
    //        console.log(`saved ${outputName}`);
    //    });
};

function stat(argv)
{
    const rl = readline.createInterface({ input: fs.createReadStream(argv.file) });
    const parser = new LogParser;
    if (argv.maxLines !== undefined) parser.setMaxLines(argv.maxLines);

    rl.on('line', line => {
        parser.putLine(line);
    });
    rl.on('close', () => {
        parser.report(path.basename(argv.file).split('.').slice(0, -1).join('.')
            , argv.plot);
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
