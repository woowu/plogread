#!/usr/bin/node --harmony
'use strict';

const fs = require('fs');
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const { SerialPort } = require('serialport');
const clc = require('cli-color');
const { MESSAGE } = require('triple-beam');
const logform = require('logform');
const winston = require('winston');
const moment = require('moment');

const timestampWidth = 10;
const modWidth = 6;
const taskWidth = 25;
const facilityNameWidth = 20;
const facilityNumWidth = 4;

const DEFAULT_LOG_FILE_MAX_SIZE = 10 * 1024;

const argv = yargs(hideBin(process.argv))
    .version('1.0.0')
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
        alias: 'r',
        describe: 'raw mode',
        nargs: 1,
        type: 'string',
    })
    .help()
    .alias('help', 'h')
    .alias('version', 'v')
    .argv;

const logFormat = logform.format((info, opts) => {
    /**
     * When I set breakpoints, and the program was stopped in a breakpoint
     * in the debugger, the output message could be damaged. But in most
     * of time, a damaged message just have some garbage characters at the
     * beginning of the message, so I can still remove the leading garbage
     * characters and recovery the message.
     */
    const fixMessage = message => {
        var s = 'wait-ticks';
        var n;
        var m = '';

        for (const c of message) {
            switch (s) {
                case 'wait-ticks':
                    if (c >= '0' && c <= '9') {
                        s = 'ticks';
                        m = c;
                    }
                    break;
                case 'ticks':
                    if (c >= '0' && c <= '9') {
                        m += c;
                    } else if (c == ' ') {
                        m += c;
                        s = 'remaining';
                    } else {
                        s = 'wait-ticks';
                        m = '';
                    }
                    break;
                case 'remaining':
                    m += c;
                    break;
            }
        }

        return m;
    };

    /* a message is a log line, split it into an object with fields */
    const split = message => {
        const pos = message.search(':');
        if (pos < 0)
            throw new Error('bad format');
        message = message.slice(0, pos) + message.slice(pos + 1);
        const words = message.trim().split(/\s+/);
        var [ticks, mod, task, facility] = words;
        const msg = words.slice(4).join(' ');
        if (msg === undefined)
            throw new Error('message too short');
        if (isNaN(parseInt(ticks)))
            throw new Error(`ticks NaN: ${ticks}`);
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
        const st = ! opts.color ? noColor : clc.white;
        const ts = ! opts.color ? noColor : clc.green;
        const md = ! opts.color ? noColor : clc.blue;
        const t = ! opts.color ? noColor : clc.yellow;
        const f = ! opts.color ? noColor : clc.blue;

        const alignRight = (str, width) => {
            return opts.padding ? str.slice(0, width).padStart(width) : str;
        }

        try {
            m.timestamp = new Date(parseInt(parseFloat(m.timestamp) * 1000))
                .toISOString().slice(11, 23);
        } catch (err) {
            m.timestamp = '*bad ticks*'
        }
        m.mod = alignRight(m.mod, modWidth);
        m.task = alignRight(m.task, taskWidth);
        m.facility = alignRight(typeof m.facility == 'number'
            ? '(' + m.facility + ')' : m.facility
            , typeof m.facility == 'number'
            ? facilityNumWidth : facilityNameWidth);

        m.systime = st(moment().format('YYYYMMDDThh:mm:ss.SSS'));
        m.timestamp = ts(m.timestamp);
        m.mod = md(m.mod);
        m.task = t(m.task);
        m.facility = f(m.facility);

        return m;
    };

    try {
        info.message = info.message.trim();
        if (! info.message) {
            info[MESSAGE] = '';
            return;
        }
        const o = split(fixMessage(info.message));
        const m = transformMessage(o);
        info[MESSAGE] = `${m.systime} ${m.timestamp} ${m.mod} ${m.task} ${m.facility} ${m.msg}`;
    } catch (error) {
        info[MESSAGE] = `*Error:* ${error.message}. The raw message is: ${info.message}`;
    }
    return info;
});

const logger = winston.createLogger({
    level: 'debug',
    transports: [
        new winston.transports.Console({
            format: logFormat({ color: argv.color, padding: true }),
        }),
    ],
});
if (argv.file)
    logger.add(new winston.transports.File({
        filename: argv.file,
        format: logFormat({ color: false, padding: false }),
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

function RawLogger(filename) {
    this.ws = fs.createWriteStream(filename);
}

RawLogger.prototype.log = function(line) {
    this.ws.write(line + '\n');
}

var rawLogger;
if (argv.raw) rawLogger = new RawLogger(argv.raw);

const device = new SerialPort({
    path: argv.device,
    baudRate: argv.baud,
    autoOpen: false,
}).on('data', makeLogLineHandler(line => {
    if (rawLogger) rawLogger.log(
        `${moment().format('YYYYMMDDThh:mm:ss.SSS')} ${line}`
    );
    logger.info(line);
}));

device.open(err => {
    if (err) {
        console.error(`Error opening ${argv.device}:`, err.message);
        process.exit(1);
    }
});
