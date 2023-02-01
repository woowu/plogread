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

const modWidth = 4;
const taskWidth = 35;
const facilityNameWidth = 30;
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
    .option('append', {
        alias: 'a',
        describe: 'append to log files',
        type: 'boolean',
        default: true,
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

    /* A message is a log line, split it into an object with fields.
     *
     * Message format:
     * tttttt Mod TaskName Facility: MessageBody.
     * - TaskName can contain spaces.
     */
    const split = message => {
        const pos = message.search(':');
        if (pos < 0) throw new Error('bad format');

        var p = pos - 1;
        while (p >= 0 && message[p] != ' ') --p;
        const facility = message.slice(p + 1, pos);
        if (! facility) throw new Error('bad format');
        while (message[p] == ' ') --p;
        /* p points to the last char of the task name */

        var q = 0;
        while (message[q] != ' ') ++q;
        const ticks = message.slice(0, q);
        if (isNaN(parseInt(ticks))) throw new Error('bad format');
        while (message[q] == ' ') ++q;
        /* q points to the first char of the module name */

        var j = q;
        while (message[j] != ' ') ++j;
        const mod = message.slice(q, j);
        if (! mod) throw new Error('bad format');
        while (message[j] == ' ') ++j;
        /* j points to the first char of the task name */

        const task = message.slice(j, p + 1);
        const msg = message.slice(pos + 1).trim();

        return { timestamp: ticks, mod, task, facility, msg };
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
            var ticks = m.timestamp;
            const hr = parseInt(ticks / 1000 / 3600);
            ticks -= hr * 3600 * 1000;
            const min = parseInt(ticks / 1000 / 60);
            ticks -= min * 60 * 1000;
            const s = parseInt(ticks / 1000);
            ticks -= s* 1000;
            const ms = ticks;

            const aligned = (n, width, c) => {
                const s = '' + n;
                return s.padStart(width, c);
            };
            m.timestamp = `${aligned(hr, 4, '0')}:${aligned(min, 2, '0')}:${aligned(s, 2, '0')}.${aligned(ms, 3, '0')}`;
        } catch (err) {
            console.error(err);
            process.exit();
            m.timestamp = '*bad ticks*'
        }
        m.mod = alignRight(m.mod, modWidth);
        m.task = alignRight(m.task, taskWidth);
        m.facility = alignRight(typeof m.facility == 'number'
            ? '(' + m.facility + ')' : m.facility
            , typeof m.facility == 'number'
            ? facilityNumWidth : facilityNameWidth);

        m.systime = st(moment().format('YYYYMMDDTHH:mm:ss.SSS'));
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
    logger.add(new winston.transports.Stream({
        //filename: argv.file,
        stream: fs.createWriteStream(argv.file, { flags: argv.append ? 'a' : 'w' }),
        format: logFormat({ color: false, padding: true }),
        //maxsize: argv.maxSize * 1024,
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

function RawLogger(filename, append) {
    this.ws = fs.createWriteStream(filename, { flags: append ? 'a' : 'w' });
}

RawLogger.prototype.log = function(line) {
    this.ws.write(line + '\n');
}

var rawLogger;
if (argv.raw) rawLogger = new RawLogger(argv.raw, argv.append);

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
