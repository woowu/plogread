#!/usr/bin/node --harmony

import yargs from 'yargs/yargs';
import readline from 'node:readline';
import fs from 'node:fs';

function WaitPowerUp(machine)
{
    this._machine = machine;
}

WaitPowerUp.prototype.putLine = function(line, lno) {
    if (line.search('system started') < 0) return;

    const words = line.split(/\s+/);
    const powerOnTime = parseFloat(words[1]) * 1000;

    this._machine.setState(new PowerOn(this._machine
        , powerOnTime, lno));
};

function PowerOn(machine, powerOnTime, lnoFirst)
{
    this._machine = machine;
    this._lastPowerStateMaster = 'None';

    this._powerOnTime = powerOnTime;
    this._lastTime = null;
    this._lnoFirst = lnoFirst;
    this._lnoLast = lnoFirst;

    this._powerDownStartTime = null;
}

PowerOn.prototype.putLine = function(line, lno) {
    this._lnoLast = lno;

    const words = line.split(/\s+/);
    const thisTime = parseInt(parseFloat(words[1]) * 1000);
    var nextState;
    
    var shutdownEndTime;
    var powerCycleCompleted = false;

    if (line.search('system started') >= 0) {
        if (this._lastTime === null)
            throw new Error(
                `lost logs at ${lno}: ` + line);
        shutdownEndTime = this._lastTime;
        powerCycleCompleted = true;
        nextState = new PowerOn(this._machine, lno, thisTime);
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

        const powerCycle = {
        };

        this._machine.completePowerCycle({
            /* lno range of this power cycle.
             */
            lnoFirst: this._lnoFirst,
            lnoLast: this._lnoLast,

            /* time info
             */
            powerOnTime: this._powerOnTime,
            lastTime: this._lastTime,
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
}

LogParser.prototype.setState = function(s) {
    this._state = s;
};

LogParser.prototype.putLine = function(line) {
    ++this._lineCount;
    if (line.search('bad format') >= 0) return;
    this._state.putLine(line, this._lineCount);
};

LogParser.prototype.completePowerCycle = function(powerCycle) {
    this._powerCycles.push(powerCycle);
};

LogParser.prototype.putInvalidPowerCycle = function(powerCycle) {
    this._invalidPowerCycles.push(powerCycle);
};

LogParser.prototype.report = function() {
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
};

function stat(argv)
{
    const rl = readline.createInterface({ input: fs.createReadStream(argv.file) });
    const parser = new LogParser;

    rl.on('line', line => {
        parser.putLine(line);
    });
    rl.on('close', () => {
        parser.report();
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
    .command('stat', 'statistics', {
        },
        stat,
    )
    .argv;
