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
    { metric: 'CapacitorTime', calculator: calcCapacitorTime },
    { metric: 'BackupTime', calculator: calcBackupTime },
    { metric: 'WaitIoDrain', calculator: calcWaitIoDrainTime},
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
    var start;
    var end = null;

    var ii;
    for (var i = 0; i < cycle.logs.length; ++i) {
        const { tick, message } = cycle.logs[i];
        if (message.search('PSCm send event PowerBelowPowersaveLevel') >= 0) {
            start = tick;
            ii = i;
        }
        if (message.search('shutdown took') >= 0) {
            end = tick;
            break;
        }
        if (message.search('PSCm send event PowerBelowShutdownLevel') >= 0) {
            start = tick;
            ii = i;
            break;
        }
    }
    if (end === null)
        for (var i = ii + 1; i < cycle.logs.length; ++i) {
            const { tick, message } = cycle.logs[i];
            if (message.search('shutdown took') >= 0) {
                end = tick;
                break;
            }
        }
    if (isNaN(start) || isNaN(end))
        throw new Error(`PSCm events is not complete. ${cycleTitle(cycle)}.`);
    return tickDiff(start, end) / 1000;
}

function calcBackupTime(cycle)
{
    var start = null;
    var end = null;
    var saveCount = 0;

    for (var i = 0; i < cycle.logs.length; ++i) {
        const { tick, message } = cycle.logs[i];
        if (message.search('save ram-backup') >= 0) {
            ++saveCount;
            if (start === null) start = tick;
        }
        if (message.search('stop data model') >= 0) {
            end = tick;
            break;
        }
    }

    if (start === null && end === null) return 0;
    if (start === null || end === null || saveCount != 4)
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

/*===========================================================================*/

function detectCycleBoundary(message)
{
    const m = message.match(/system started.*coldStart ([01])/);
    if (m)
        return {
            state: 'cycle-start',
            coldStart: +m[1] == 1,
        };
    if (message.search('reset mcu') >= 0)
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

    if (! cycle && state == 'cycle-start')
        cycle = {
            seqno: seqno++,
            lnoStart: lno,
            coldStart,
            logs: [{ time, tick, mod, task, message }],
        };
    if (cycle && state == 'cycle-end')
        cycle = { ...cycle, lnoEnd: lno };
    if (cycle && state == 'unknown')
        cycle = {
            ...cycle,
            logs: [...cycle.logs, {
                time, tick, mod, task, message
            }],
        };

    return { cycle, lno, seqno };
}

function handleCycle(cycle, csvStream)
{
    const err = checkCycleHealthy(cycle);
    if (err != 'ok') {
        console.log(`cycle ${cycle.seqno} from line`
            + ` ${cycle.lnoStart} to ${cycle.lnoEnd} has an error: ${err}`);
        return;
    }

    csvStream.write(`${cycle.seqno},${cycle.lnoStart},${cycle.lnoEnd}`);

    const metrics = [];
    for (const metric of metricCalculators) {
        metrics.push({
            name: metric.name,
            value: metric.calculator(cycle),
        });
    }

    for (const m of metrics)
        csvStream.write(`,${m.value}`);
    csvStream.write('\n');
}

function isCycleCompleted(cycle)
{
    return ! isNaN(cycle.lnoStart) && ! isNaN(cycle.lnoEnd);
}

function checkCycleHealthy(cycle)
{
    const badMessages = [
        'watchdog reset detected',
        'invalid powerdown detected',
    ];
    for (const log of cycle.logs) {
        for (const bad of badMessages)
            if (log.message.search(bad) >= 0)
                return bad;
    }

    if (analysisShutdownType(cycle) == 'No Backup')
        return 'ok';

    var shutdownReason = null;
    for (const log of cycle.logs.slice().reverse()) {
        const m = log.message.match(/update shutdown reason to ([0-9]+)/);
        if (m) {
            shutdownReason = +m[1];
            break;
        }
    }
    if (shutdownReason != 3)
        return `not update shutdown reason properly: ${shutdownReason}`;
    return 'ok';
}

function stat(argv)
{
    const rl = readline.createInterface({
        input: fs.createReadStream(argv.file)
    });

    var context = {
        cycle: null,
        lno: 0,
        seqno: 0,
    };

    const csvStream = fs.createWriteStream(`${argv.dataName}.csv`);
    var header = 'No,LnoFrom,LnoTo';
    for (const metric of metricCalculators) {
        header += `,${metric.metric}`;
    }
    header += '\n';
    csvStream.write(header);

    rl.on('line', line => {
        if (argv.maxLines && context.lno > argv.maxLines) return;

        var { cycle, lno, seqno } = parse(context, line);
        if (cycle && isCycleCompleted(cycle)) {
            handleCycle(cycle, csvStream);
            cycle = null;
        }
        context = { cycle, lno, seqno };
    });

    rl.on('close', async () => {
        csvStream.end();
        const cmdline = `${statScript}`
            + ` --dir ${process.cwd()} --data "${argv.dataName}"`;
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
            yargs.option('plot', {
                alias: 'P',
                describe: 'not to plot',
                type: 'boolean',
            });
        },
        stat,
    )
    .argv;
