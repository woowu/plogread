#!/usr/bin/node --harmony
'use strict';

const fs = require('fs');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const { SerialPort } = require('serialport');
const clc = require('cli-color');

const timestampWidth = 10;
const modWidth = 4;
const taskWidth = 12;
const facilityNameWidth = 22;
const facilityNumWidth = 4;

var ws;
var argv;

const makeLogLineHandler = (handler) => {
    var response = '';
    return serialData => {
        if (argv.raw) return console.log(serialData.toString());
        response += serialData.toString();
        const scanLines = (remaining, cb) => {
            if (! remaining) return cb('');
            const pos = remaining.search('\n');
            if (pos < 0) return cb(remaining);
            const line = remaining.slice(0, pos);
            handler(line);
            scanLines(remaining.slice(pos + 1), cb);
        };
        scanLines(response, remained => {
            response = remained;
        });
    };
};

/**
 * Align and coloring
 */
const printLog = log => {
    const noColor = str => str;
    const ts = ! argv.color ? noColor : clc.green;
    const m = ! argv.color ? noColor : clc.blue;
    const t = ! argv.color ? noColor : clc.yellow;
    const f = ! argv.color ? noColor : clc.blue;

    if (! log) return;

    const alignRight = (str, width) => str.slice(0, width).padStart(width);

    log.timestamp = alignRight(log.timestamp, timestampWidth);
    log.mod = alignRight(log.mod, modWidth);
    log.task = alignRight(log.task, taskWidth);
    log.facility = alignRight(typeof log.facility == 'number'
        ? '(' + log.facility + ')' : log.facility
        , typeof log.facility == 'number'
        ? facilityNumWidth : facilityNameWidth);

    if (ws)
        ws.write([log.timestamp, log.mod, log.task, log.facility, log.msg]
            .join(' ') + '\n');
    console.log(ts(log.timestamp), m(log.mod), t(log.task)
        , f(log.facility), log.msg);
};

/**
 * Parse a log line
 */
const processLogLine = line => {
    const split = line => {
        line = line.trim();
        if (! line) return null;
        const pos = line.search(':');
        if (pos < 0) return;
        line = line.slice(0, pos) + line.slice(pos + 1);
        const words = line.trim().split(/\s+/);
        var [ticks, mod, task, facility] = words;
        const msg = words.slice(4).join(' ');
        if (msg === undefined) return null; /* an incompleted line */
        if (isNaN(parseInt(ticks))) return null; /* bad line */
        const timestamp = ticks
            ? (ticks / 1000).toFixed(3).slice(0, timestampWidth)
            : '';
        mod = mod ? mod : '';
        task = task ? task : '';
        if (! isNaN(parseInt(facility)))
            facility = parseInt(facility);
        else
            facility = facility ? facility : '';
        return { timestamp, mod, task, facility, msg };
    };
    printLog(split(line));
};

argv = yargs(hideBin(process.argv))
    .version('0.1.0-pre.1')
    .option('device', {
        alias: 'd',
        describe: 'Serial device name',
        demandOption: true,
        nargs: 1,
    })
    .option('baud', {
        alias: 'b',
        describe: 'Serial device baudrate',
        nargs: 1,
        type: 'number',
        default: 921600,
    })
    .option('write', {
        alias: 'w',
        describe: 'also write to a file',
        nargs: 1,
        type: 'string',
    })
    .option('color', {
        describe: 'ascii color',
        type: 'boolean',
        default: true,
    })
    .option('raw', {
        describe: 'raw mode',
        type: 'boolean',
    })
    .help()
    .alias('help', 'h')
    .alias('version', 'v')
    .argv;

const device = new SerialPort({
    path: argv.device,
    baudRate: argv.baud,
    autoOpen: false,
}).on('data', makeLogLineHandler(processLogLine));

if (argv.write) ws = fs.createWriteStream(argv.write);
device.open(err => {
    if (err) {
        console.error(`Error opening ${argv.device}:`, err.message);
        process.exit(1);
    }
});
