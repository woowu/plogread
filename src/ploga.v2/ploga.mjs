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
const statScript = path.join(__dirname, 'stat.R');

const TICK_START_VALUE = 0xfffc0000;
var verbose = false;

/*===========================================================================*/

const metricCalculators = [
    { metric: 'ShutdownType', calculator: analysisShutdownType },
    { metric: 'CompleteStartup', calculator: calcCompleteStartup },
    { metric: 'CapacitorTime', calculator: calcCapacitorTime },
    { metric: 'BackupTime', calculator: calcBackupTime },
    { metric: 'WaitIoDrain', calculator: calcWaitIoDrainTime },
    { metric: 'ShutdownDelay', calculator: calcShutdownDelay},
    { metric: 'WaitMeas', calculator: calcWaitMeansTime },
    { metric: 'Bridging', calculator: calcBridgingTime },
    { metric: 'WrShutdownReason', calculator: calcWriteShutdownReasonTime },
    { metric: 'PowerRecoverTimes', calculator: calcPowerRecoverTimes },
];

/*===========================================================================*/

function cycleTitle(cycle)
{
    return `cycle ${cycle.seqno}: ` + ` lno: ${cycle.lnoStart} to ${cycle.lnoEnd}`;
}

function tickDiff(from, to)
{
    const mod = 2**32;
    var n = (to + (mod - from)) % mod;
    if (n > 2**31) n -= mod;
    return n;
}

function decodeLogLine(logLine)
{
    const words = logLine.split(/\s+/);
    const time = new Date(words[0]);
    const tick = parseInt(parseFloat(words[1]) * 1000);
    const longMsg = logLine.slice(logLine.search(words[1]) + words[1].length)
        .trim();

    return {
        time,
        tick,
        mod: longMsg.split(/\s+/)[0],
        task: longMsg.split(/\s+/)[1],
        message: longMsg.split(/\s+/).slice([2]).join(' '),
    };
}

/*===========================================================================*/

function analysisShutdownType(cycle)
{
    for (const log of cycle.logs) {
        if (log.message.search('save ram-back') >= 0)
            return 'With Backup'
    }
    return 'No Backup';
}

function calcCapacitorTime(cycle)
{
    var start = null;
    var end = null;

    var i = cycle.logs.length - 1;
    for (; i >= 0; --i) {
        const { tick, message } = cycle.logs[i];
        if (message.search('shutdown took') >= 0
            || message.search('enter psm wait-for-reset') >= 0) {
            end = tick;
            break;
        }
    }
    if (end == null)
        throw new Error(`PSCm events is not complete. ${cycleTitle(cycle)}.`);

    for (; i >= 0; --i) {
        const { tick, message } = cycle.logs[i];
        if (message.search('PSCm send event PowerBelowPowersaveLevel') >= 0
            || message.search('PSCm send event PowerBelowShutdownLevel') >= 0)
            break;
    }
    for (; i >= 0; --i) {
        const { tick, message } = cycle.logs[i];
        if (message.search('power supply state switch: Normal -> FilteringTime')
            >= 0) {
            start = tick;
            break;
        }
    }

    if (start == null || end == null)
        throw new Error(`PSCm events is not complete. ${cycleTitle(cycle)}.`);
    return tickDiff(start, end) / 1000;
}

function calcBackupTime(cycle)
{
    var start = null;
    var end = null;

    for (var i = 0; i < cycle.logs.length; ++i) {
        const { tick, message } = cycle.logs[i];
        if (message.search('PSCm send slaves with event stop') >= 0) {
            if (start === null) start = tick;
        }
        if (message.search('PSCm send slaves with event WaitForTaskCompletion') >= 0) {
            end = tick;
            break;
        }
    }

    if (start === null && end === null) return 0;
    if (start === null || end === null)
        throw new Error(`incompleted saving of ram-backup`);
    return tickDiff(start, end) / 1000;
}

function calcWaitIoDrainTime(cycle)
{
    for (const log of cycle.logs) {
        const { tick, message } = log;
        const m = message.match(/waiting ubi drain took ([0-9]+) ms/);
        if (m) return +m[1] / 1000;
    }
    return 0;
}

function calcShutdownDelay(cycle)
{
    for (const log of cycle.logs) {
        const { tick, message } = log;
        const m = message.match(/delayed ([0-9]+) ms before handling power down/);
        if (m) return +m[1] / 1000;
    }
    throw new Error('lost shutdown delay message');
}

function calcBridgingTime(cycle)
{
    var start = null;
    var end = null;

    for (const log of cycle.logs) {
        const { tick, message } = log;
        if (message.search(/handle PowerBelowPowersaveLevel/) >= 0)
            start = tick;
        if (message.search(/handle PowerBelowShutdownLevel/) >= 0)
            end = tick;
    }
    return (start != null && end != null) ? tickDiff(start, end) / 1000 : 0;
}

function calcWaitMeansTime(cycle)
{
    var version = -1;

    for (const log of cycle.logs) {
        const { message } = log;
        if (message.search(
            /MultiModuleSystemApplicationApp::stopMeasurementSystemAndWaitData/
            ) >= 0) {
            version = 1;
            break;
        }
        if (message.search(
            /stopping meas processing/
            ) >= 0) {
            version = 2;
            break;
        }
    }
    if (version < 0) return 0;

    const forVersion1 = () => {
        var intvl = [null, null];
        for (const log of cycle.logs) {
            const { tick, message } = log;
            var m;
            if (message.search('start shutdown') >= 0)
                intvl[0] = tick;
            if (message.search('PSCm send slaves with event stop') >= 0
                || message.search('non-backup done') >= 0)
                intvl[1] = tick;
        }
        return intvl;
    };
    const forVersion2 = () => {
        var intvl = [null, null];
        for (const log of cycle.logs) {
            const { tick, message } = log;
            var m;
            if (message.search(/stopping meas processing$/) >= 0)
                intvl[0] = tick;
            if (message.search(/stopping meas processing: done/) >= 0)
                intvl[1] = tick;
        }
        return intvl;
    };

    const intvl = version == 1 ? forVersion1() : forVersion2();
    const start = intvl[0];
    const end = intvl[1];

    if (start == null && end != null
        ||start != null && end == null)
        throw new Error(`stopping meas not completed? ${cycleTitle(cycle)}`);

    return start == null && end == null ? 0 : tickDiff(start, end) / 1000;
}

function calcWriteShutdownReasonTime(cycle)
{
    var start = null;
    var sepLines;

    for (const log of cycle.logs) {
        const { tick, message } = log;

        if (start == null && (message.search(/update shutdown reason to 3$/) >= 0
            || message.search(/writing shutdown reason 3 for shutdown/) >= 0)) {
            start = tick;
            sepLines = 0;
        }
        if (start !== null && message.search(/write shutdown reason succeeded/) >= 0)
            return tickDiff(start, tick) / 1000;
        if (start !== null && message.search(/write shutdown reason succeeded/) <= 0
            && ++sepLines >= 5) {
            console.error(`lost writing of shutdown reason? cycle: `
                + ` ${cycle.seqno} ${cycle.lnoStart} ${cycle.lnoEnd}`);
        }
    }
    return 0;
}

function calcPowerRecoverTimes(cycle)
{
    var powerSaveStarted = false;
    var n = 0;

    for (const log of cycle.logs) {
        const { message } = log;
        if (message.search(/handle PowerBelowPowersaveLevel/) >= 0)
            powerSaveStarted = true;
        if (powerSaveStarted && message.search(
            /handle PowerAboveStartupLevel/) >= 0) {
            powerSaveStarted = false;
            ++n;
        }
    }
    return n;
}

function calcCompleteStartup(cycle)
{
    for (const log of cycle.logs) {
        const { message } = log;
        if (message.search(/handle PowerAboveStartupLevel/) >= 0)
            return true;
    }
    return false;
}

/*===========================================================================*/

function detectCycleBoundary(message)
{
    const m = message.match(/system started.*coldStart ([01])/);
    if (m)
        return {
            state: 'cycle-start',
            coldStart: +m[1] == 1,
        };
    if (message.search('dprintf buf used') >= 0
        || message.search('enter psm wait-for-reset') >= 0)
        return {
            state: 'cycle-end',
        };
    return {
        state: 'unknown',
    };
}

function parse(context, line)
{
    var { cycle, lno, seqno } = context;

    const { time, tick, mod, task, message } = decodeLogLine(line);
    const { state, coldStart } = detectCycleBoundary(message);
    ++lno;

    if (cycle && state == 'cycle-start' && ! coldStart)
        console.error(`an incompleted cycle detected: seqno ${cycle.seqno}`
            + ` lno start ${cycle.lnoStart} current line ${lno}`);

    if (state == 'cycle-start')
        cycle = {
            seqno: seqno++,
            lnoStart: lno,
            coldStart,
            logs: [{ time, tick, mod, task, message }],
        };
    if (cycle && state == 'cycle-end')
        cycle = {
            ...cycle,
            logs: [...cycle.logs, {
                time, tick, mod, task, message
            }],
            lnoEnd: lno,
        };
    if (cycle && state == 'unknown')
        cycle = {
            ...cycle,
            logs: [...cycle.logs, {
                time, tick, mod, task, message
            }],
        };

    return { cycle, lno, seqno };
}

function isCycleCompleted(cycle)
{
    return ! isNaN(cycle.lnoStart) && ! isNaN(cycle.lnoEnd);
}

function checkCycleHealthy(cycle)
{
    const findWritingShutdownReason = () => {
        var shutdownReason;

        /* for format 1 */
        shutdownReason = null;
        for (const log of cycle.logs.slice().reverse()) {
            const m = log.message.match(/update shutdown reason to ([0-9]+)/);
            if (m) {
                shutdownReason = +m[1];
                return { reason: shutdownReason, success: true };
            }
        }

        /* for format 2 */
        shutdownReason = null;
        for (const log of cycle.logs) {
            var m;
            const p1 = /writing shutdown reason ([0-9]+) for shutdown/;
            const p2 = /writing shutdown reason succeeded/;

            if (shutdownReason === null) {
                m = log.message.match(p1);
                if (m)
                    shutdownReason = +m[1];
            } else {
                m = log.message.match(p1);
                if (m)
                    return { reason: shutdownReason, success: true };
            }
        }

        return { reason: shutdownReason, success: false };
    };
    const checkBadMessages = () => {
        const badMessages = [
            'watchdog reset detected',
            'invalid powerdown detected',
        ];
        for (const log of cycle.logs) {
            for (const bad of badMessages)
                if (log.message.search(bad) >= 0)
                    return bad;
        }
        return null;
    };
    const checkPowerUpDownExtDevices = () => {
        var state = 0;
        for (const log of cycle.logs) {
            const m = log.message.match(/power ([a-z]+) external devices/);
            if (! m) continue;
            if (m[1] == 'up') ++state;
            if (m[1] == 'down') --state;
            if (state > 1 || state < 0)
                return state;
        }
        return state;
    };
    const checkLogIntegrity = () => {
        for (const log of cycle.logs) {
            if (log.message.search(/bad format/) >= 0)
                return 'log message damanged';
        }
    };

    var err;

    err = checkLogIntegrity();
    if (err) return err;

    err = checkBadMessages();
    if (err) return err;

    const extDevicesState = checkPowerUpDownExtDevices();
    if (extDevicesState != 0)
        return `external devices is not correctly power-up or power-down: state %{extDevicesState}`;

    if (analysisShutdownType(cycle) == 'No Backup')
        return 'ok';

    const { reason, success } = findWritingShutdownReason();
    if (reason != 3)
        return `not update shutdown reason properly: ${reason}`;
    return 'ok';
}

/*===========================================================================*/

function statCycle(cycle, csvStream)
{
    console.log(cycleTitle(cycle));

    const err = checkCycleHealthy(cycle);
    if (err != 'ok') {
        console.log(`cycle ${cycle.seqno} from line`
            + ` ${cycle.lnoStart} to ${cycle.lnoEnd} has an error: ${err}`);
        return;
    }

    var error = false;
    const metrics = [];
    try {
        for (const metric of metricCalculators) {
            metrics.push({
                name: metric.name,
                value: metric.calculator(cycle),
            });
        }
    } catch (e) {
        console.error(e.message);
        error = true;
    }

    if (error) {
        console.log(`cycle ${cycle} skipped`);
        return;
    }
    csvStream.write(`${cycle.seqno},${cycle.lnoStart},${cycle.lnoEnd},${cycle.coldStart}`);
    for (const m of metrics)
        csvStream.write(`,${m.value}`);
    csvStream.write('\n');
}

function ioCycle(cycle)
{
    const err = checkCycleHealthy(cycle);
    if (err != 'ok') {
        console.log(`cycle ${cycle.seqno} from line`
            + ` ${cycle.lnoStart} to ${cycle.lnoEnd} has an error: ${err}`);
        return;
    }

    const printIoStateChange = (name, time, state, lno, lastPrintTime) => {
        const ioNameTrans = {
            '0a00': 'scs_l1_on',
            '0e07': 'scs_l1_off',
            '0e06': 'scs_l2_on',
            '0e05': 'scs_l2_off',
            '0e04': 'scs_l3_on',
            '0e03': 'scs_l3_off',
            '0a01': 'lc_3ph_on',
            '0a03': 'lc_3ph_off',
        };

        if (ioNameTrans[name] != undefined) name = ioNameTrans[name];
        console.log(lno.toString().padStart(4, ' ')
            , time.toString().padStart(10, ' ')
            , (tickDiff(lastPrintTime, time) / 1000).toFixed(3).padStart(8, ' ')
            , name.padStart(15, ' ')
            , state);
        return time;
    };

    const printPowerStateInfo = (log, lno, lastPrintTime) => {
        const { tick, message } = log;
        const m = message.match(/PSCm send event (Power[a-zA-Z0-9]+)/); 
        if (! m) return lastPrintTime;
        console.log(lno.toString().padStart(4, ' ')
            , tick.toString().padStart(10, ' ')
            , (tickDiff(lastPrintTime, tick) / 1000).toFixed(3).padStart(8, ' ')
            , ' '.repeat(15)
            , m[1]);
        return tick;
    };

    const printPowersaveInfo = (log, lno, lastPrintTime) => {
        const { tick, message } = log;
        const m = message.match(/(power .* external devices)/); 
        if (! m) return lastPrintTime;
        console.log(lno.toString().padStart(4, ' ')
            , tick.toString().padStart(10, ' ')
            , (tickDiff(lastPrintTime, tick) / 1000).toFixed(3).padStart(8, ' ')
            , ' '.repeat(15)
            , m[1]);
        return tick;
    };

    const printShutdownInfo = (log, lno, lastPrintTime) => {
        const { tick, message } = log;
        const n = message.search('start shutdown');
        if (n < 0) return lastPrintTime;
        console.log(lno.toString().padStart(4, ' ')
            , tick.toString().padStart(10, ' ')
            , (tickDiff(lastPrintTime, tick) / 1000).toFixed(3).padStart(8, ' ')
            , ' '.repeat(15)
            , message.slice(n));
        return tick;
    };

    var lno = 0;
    var lastPrintTime = 0;
    const ioStatePool = {};
    console.log(`-- cycle ${cycle.seqno} lno ${cycle.lnoStart} to ${cycle.lnoEnd}:`);
    for (const log of cycle.logs) {
        const { tick, message } = log;
        ++lno;

        lastPrintTime = printPowerStateInfo(log, lno, lastPrintTime);
        lastPrintTime = printPowersaveInfo(log, lno, lastPrintTime);
        lastPrintTime = printShutdownInfo(log, lno, lastPrintTime);

        const m = message.match(/gpio ([0-9a-f]+) state ([0-1]+)/);
        if (! m) continue;

        const ioName = m[1];
        const ioState = +m[2];
        if (ioStatePool[ioName] == undefined)
            ioStatePool[ioName] = -1;
        if (ioStatePool[ioName] != ioState) {
            ioStatePool[ioName] = ioState;
            lastPrintTime = printIoStateChange(ioName
                , tick
                , ioState
                , lno
                , lastPrintTime
            );
        }
    }
    console.log();
}

function parseCycles(argv, onCycle, onEnd)
{
    const rl = readline.createInterface({
        input: (argv.file == null || argv.file == '-')
            ? process.stdin : fs.createReadStream(argv.file),
        terminal: false,
    });

    var context = {
        cycle: null,
        lno: 0,
        seqno: 0,
    };

    rl.on('line', line => {
        if (argv.maxLines && context.lno == argv.maxLines) return;

        var { cycle, lno, seqno } = parse(context, line);
        if (cycle && isCycleCompleted(cycle)) {
            onCycle(cycle);
            cycle = null;
        }
        context = { cycle, lno, seqno };
    });

    rl.on('close', onEnd);
}

function stat(argv)
{
    const csvStream = fs.createWriteStream(`${argv.dataName}.csv`);
    var header = 'No,LnoFrom,LnoTo,ColdStart';
    for (const metric of metricCalculators) {
        header += `,${metric.metric}`;
    }
    header += '\n';
    csvStream.write(header);

    parseCycles(argv, cycle => {
        statCycle(cycle, csvStream);
    }, async () => {
        csvStream.end();
        if (! argv.plot) return;

        const cmdline = `${statScript}`
            + ` --dir ${process.cwd()} --data "${argv.dataName}"`;
        console.log(cmdline);
        const { stdout, stderr } = await execp(cmdline);
        if (stderr) console.error(stderr);
        console.log(stdout);
    });
}

function iotrace(argv)
{
    parseCycles(argv, cycle => {
        if (argv.cycle === undefined || cycle.seqno == argv.cycle)
            ioCycle(cycle);
    }, async () => {
    });
}

/*===========================================================================*/

const argv = yargs(process.argv.slice(2))
    .option('f', {
        alias: 'file',
        describe: 'log filename', 
        nargs: 1,
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
        yargs.option('plot', {
            alias: 'P',
            describe: 'to plot',
            type: 'boolean',
            default: true,
        });
        },
        stat,
    )
    .command('iotrace', 'trace IO status', yargs => {
        yargs.option('cycle', {
            alias: 'c',
            describe: 'seqno of cycle',
            nargs: 1,
            type: 'number',
        });
        },
        iotrace,
    )
    .argv;
