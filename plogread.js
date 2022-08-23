#!/usr/bin/node --harmony
'use strict';

const fs = require('fs');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const { SerialPort } = require('serialport');
const clc = require('cli-color');
const { MESSAGE } = require('triple-beam');
const jsonStringify = require('safe-stable-stringify');
const logform = require('logform');
const winston = require('winston');

const timestampWidth = 10;
const modWidth = 4;
const taskWidth = 25;
const facilityNameWidth = 20;
const facilityNumWidth = 4;

const DEFAULT_LOG_FILE_MAX_SIZE = 10 * 1024;

const argv = yargs(hideBin(process.argv))
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
    .option('file', {
        alias: 'f',
        describe: 'also write to a file',
        nargs: 1,
        type: 'string',
    })
    .option('max-size', {
        alias: 's',
        describe: 'maxsize of each saved log file (in KB)',
        nargs: 1,
        type: 'number',
        default: DEFAULT_LOG_FILE_MAX_SIZE,
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

const logFormat = logform.format((info, opts) => {
    /* a message is a log line, split it into an object with fields */
    const split = message => {
        message = message.trim();
        if (! message) return null;
        const pos = message.search(':');
        if (pos < 0) return null;
        message = message.slice(0, pos) + message.slice(pos + 1);
        const words = message.trim().split(/\s+/);
        var [ticks, mod, task, facility] = words;
        const msg = words.slice(4).join(' ');
        if (msg === undefined) return null; /* an incompleted message */
        if (isNaN(parseInt(ticks))) return null; /* bad message */
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

    /**
     * padding and coloring
     */
    const transformMessage = m => {
        const noColor = str => str;
        const ts = ! opts.color ? noColor : clc.green;
        const md = ! opts.color ? noColor : clc.blue;
        const t = ! opts.color ? noColor : clc.yellow;
        const f = ! opts.color ? noColor : clc.blue;

        const alignRight = (str, width) => {
            return opts.padding ? str.slice(0, width).padStart(width) : str;
        }

        try {
            m.timestamp = new Date(parseInt(parseFloat(m.timestamp) * 1000))
                .toISOString().slice(11, 22);
        } catch (err) {
            m.timestamp = '*bad ticks*'
        }
        m.mod = alignRight(m.mod, modWidth);
        m.task = alignRight(m.task, taskWidth);
        m.facility = alignRight(typeof m.facility == 'number'
            ? '(' + m.facility + ')' : m.facility
            , typeof m.facility == 'number'
            ? facilityNumWidth : facilityNameWidth);

        m.timestamp = ts(m.timestamp);
        m.mod = md(m.mod);
        m.task = t(m.task);
        m.facility = f(m.facility);

        return m;
    };

    try {
        const o = split(info.message);
        if (! o) {
            info[MESSAGE] = `*bad message* ${info.message}`;
        } else {
            const m = transformMessage(o);
            info[MESSAGE] = `${m.timestamp} ${m.mod} ${m.task} ${m.facility} ${m.msg}`;
        }
    } catch (error) {
        info[MESSAGE] = '*bad message*';
    }
    return info;

    const stringifiedRest = jsonStringify(Object.assign({}, info, {
        level: undefined,
        message: undefined,
        splat: undefined
    }));

    const padding = info.padding && info.padding[info.level] || '';
    if (stringifiedRest !== '{}') {
        info[MESSAGE] = `${info.level}:${padding} ${info.message} ${stringifiedRest}`;
    } else {
        info[MESSAGE] = `${info.level}:${padding} ${info.message}`;
    }

    return info;
});

const logger = winston.createLogger({
    level: 'debug',
    transports: [
        new winston.transports.Console({
            format: logFormat({ color: argv.color, padding: true}),
        }),
    ],
});
if (argv.file)
    logger.add(new winston.transports.File({
        filename: argv.file,
        format: logFormat({ color: false, padding: false}),
        maxsize: argv.maxSize * 1024,
    }));

const makeLogLineHandler = (handler) => {
    var response = '';
    return serialData => {
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

const device = new SerialPort({
    path: argv.device,
    baudRate: argv.baud,
    autoOpen: false,
}).on('data', makeLogLineHandler(line => {
    if (argv.raw) return console.log(line);
    logger.info(line);
}));

device.open(err => {
    if (err) {
        console.error(`Error opening ${argv.device}:`, err.message);
        process.exit(1);
    }
});
