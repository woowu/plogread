#!/usr/bin/node --harmony

import { tmpdir } from 'node:os';
import path from 'node:path';
import { exec } from 'node:child_process';
import crypto from 'node:crypto';
import readline from 'node:readline';
import yargs from 'yargs/yargs';
import fs from 'node:fs';

const TICK_START_VALUE = 0xfffc0000;

function WaitPowerUp(machine)
{
    this._machine = machine;
}

WaitPowerUp.prototype.putLine = function(line, lno) {
    const m = line.match(/system started.*coldStart ([01])/);
    if (! m) return;

    const words = line.split(/\s+/);
    const powerOnTime = parseFloat(words[1]) * 1000;

    this._machine.setState(new PowerOn(this._machine
        , powerOnTime, lno, m[1] == '1'));
};

function PowerOn(machine, powerOnTime, lnoFirst, coldStart)
{
    this._machine = machine;
    this._lastPowerStateMaster = 'None';

    this._powerOnTime = powerOnTime;
    this._lastTime = null;
    this._lnoFirst = lnoFirst;
    this._lnoLast = lnoFirst;
    this._coldStart = coldStart;

    this._powerDownStartTime = null;
}

PowerOn.prototype.putLine = function(line, lno) {
    this._lnoLast = lno;

    const words = line.split(/\s+/);
    const thisTime = parseInt(parseFloat(words[1]) * 1000);
    var nextState;
    
    var shutdownEndTime;
    var powerCycleCompleted = false;

    const m = line.match(/system started.*coldStart ([01])/);
    if (m) {
        if (this._lastTime === null)
            throw new Error(
                `lost logs at ${lno}: ` + line);
        shutdownEndTime = this._lastTime;
        powerCycleCompleted = true;
        nextState = new PowerOn(this._machine, lno, thisTime, m[1] == '1');
    } else if (line.search('UARTs will be stopped') >= 0) {
        shutdownEndTime = thisTime;
        powerCycleCompleted = true;
        nextState = new WaitPowerUp(this._machine);
    }

    this._lastTime = thisTime;

    if (powerCycleCompleted) {
        const powerDownDuration = shutdownEndTime >= this._powerDownStartTime
            ? shutdownEndTime - this._powerDownStartTime
            : 2**32 - this._powerDownStartTime + shutdownEndTime;

        this._machine.completePowerCycle({
            /* lno range of this power cycle.
             */
            lnoFirst: this._lnoFirst,
            lnoLast: this._lnoLast,
            
            coldStart: this._coldStart,

            /* time info
             */
            powerOnTime: this._powerOnTime,
            lastTime: this._lastTime,
            powerDownStartTime: this._powerDownStartTime,
            powerDownDuration,

            lastPowerState: this._lastPowerStateMaster,
        });
        this._machine.setState(nextState);
        return;
    }

    this._detectPowerState(line);

    if (line.search('handle PowerBelowPowersaveLevel') >= 0
        || line.search('handle PowerBelowShutdownLevel') >= 0
        || line.search('handlePowerAboveStartupLevel') >= 0) {
        const words = line.split(/\s+/);
        this._powerDownStartTime = parseInt(parseFloat(words[1]) * 1000);
    }

    if (line.search('logging stopped') >= 0
        || line.search('assertion failed') >= 0) {
        this._machine.putInvalidPowerCycle({
            /* lno range of this power cycle.
             */
            lnoFirst: this._lnoFirst,
            lnoLast: this._lnoLast,
            line: line,
        });
        this._machine.setState(new WaitPowerUp(this._machine));
    }
};

PowerOn.prototype._detectPowerState = function(line) {
    const regexp = /enter PowerStateMaster(.*)/;
    const m = line.match(regexp);
    if (m) {
        this._lastPowerStateMaster = m[1];
        return;
    }

    if (line.search('enter normal-operation') >= 0)
        this._lastPowerStateMaster = 'normal-operation';
    else if (line.search('enter infr-ready') >= 0)
        this._lastPowerStateMaster = 'infr-ready';
};

function LogParser()
{
    this._lineCount = 0;
    this._state = new WaitPowerUp(this);
    this._powerCycles = [];
    this._invalidPowerCycles = [];
    this._maxLines = 0;
}

LogParser.prototype.setMaxLines = function(n) {
    this._maxLines = n;
};

LogParser.prototype.setState = function(s) {
    this._state = s;
};

LogParser.prototype.putLine = function(line) {
    if (this._maxLines && this._lineCount == this._maxLines)
        return;
    ++this._lineCount;
    if (line.search('bad format') >= 0) return;
    this._state.putLine(line, this._lineCount);
};

LogParser.prototype.completePowerCycle = function(powerCycle) {
    if (! powerCycle.coldStart)
        this._powerCycles.push(powerCycle);
    else
        console.log('dropped cold-start power cycle');
};

LogParser.prototype.putInvalidPowerCycle = function(powerCycle) {
    this._invalidPowerCycles.push(powerCycle);
};

LogParser.prototype.report = function(datasetName, rScript) {
    console.log(`Analyzed ${this._powerCycles.length} power cycles:\n`);

    const types = {};
    for (const c of this._powerCycles) {
        if (types[c.lastPowerState] === undefined)
            types[c.lastPowerState] = [c];
        else
            types[c.lastPowerState].push(c);
    }

    for (const t in types) {
        const powerCycles = types[t];
        const powerDownMin = Math.min.apply(Math, powerCycles.map(o => o.powerDownDuration));
        const powerDownMax = Math.max.apply(Math, powerCycles.map(o => o.powerDownDuration));
        console.log(`  power down after ${t}: ${powerCycles.length};`
            + ` shutdown time min ${(powerDownMin / 1000).toFixed(3)}`
            + ` max ${(powerDownMax / 1000).toFixed(3)}`);
    }

    console.log('\n${this._invalidPowerCycles.length} Invalid power cycles:');
    for (const c of this._invalidPowerCycles)
        console.log(`  [${c.lnoFirst}, ${c.lnoLast}]: ${c.line}`);

    if (! rScript) return;

    const tmpDir = tmpdir();
    const csvName = path.join(tmpDir
        , `${crypto.randomBytes(6).readUIntBE(0, 6).toString(36)}.csv`);
    const outputName = path.join(tmpDir, `${datasetName}.png`)
    const os = fs.createWriteStream(csvName);
    os.write('PowerDownStartTime,PowerDownUsedTime,StateWhenPowerDown\n');
    for (const c of this._powerCycles) {
        var t = c.powerDownStartTime;
        if (t < TICK_START_VALUE)
            t += 2**32 - TICK_START_VALUE;
        else
            t -= TICK_START_VALUE;
        os.write(`${t/1000},${c.powerDownDuration/1000},${c.lastPowerState}\n`);
    }
    os.end();
    exec(`Rscript ${rScript} --csv ${csvName} --out ${outputName}`
        , (err, stdout, stderr) => {
            if (err) throw new Error(err);
            console.log(`saved ${outputName}`);
        });
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
