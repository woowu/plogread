#!/usr/bin/node --harmony
'use strict';

const fs = require('fs');
const net = require('net');
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
        describe: 'Serial device name, or server socket in form TCP:ip-addr:port',
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
    })
    .help()
    .alias('help', 'h')
    .alias('version', 'v')
    .argv;

const logFormat = logform.format((() => {
    const symbols = {};

    return (info, opts) => {
        /**
         * Non-printable char in a log file can cause issue when using text tool
         * like grep, hence I replace them with '.' This function provided for
         * remove/replace non-printable characters in the message which may caused
         * by the meter UART has some remainning bytes in the buffer filled before
         * the meter reset. These previous remained bytes are likely been damaged.
         */
        const fixMessage = message => {
            const PRINTABLE_ASCII_MIN = 32;
            const PRINTABLE_ASCII_MAX = 127;

            var j = 0;
            while (j < message.length && (message.charCodeAt(j) < PRINTABLE_ASCII_MIN
                    || message.charCodeAt(j) > PRINTABLE_ASCII_MAX))
                ++j;
            var q = message.length - 1;
            while (q >= 0 && (message.charCodeAt(q) < PRINTABLE_ASCII_MIN
                    || message.charCodeAt(q) > PRINTABLE_ASCII_MAX))
                --q;

            var m = '';
            for (const c of message.slice(j, q + 1)) {
                if (c.charCodeAt(0) < PRINTABLE_ASCII_MIN
                    || c.charCodeAt(0) > PRINTABLE_ASCII_MAX)
                    m += '.'
                else
                    m += c;
            }
                
            return m;
        };

        const extractSymbols = msg => {
            const k = msg.search('@Symbols:');
            if (k == -1) return false;

            const tokens = msg.slice(k + '@Symbols:'.length).trim().split(' ');
            for (const t of tokens) {
                symbols[t.split('=')[0]] = t.split('=')[1];
            }
            return true;
        };

        const translateSymbols = msg => {
            for (const a in symbols) {
                if (! symbols.hasOwnProperty(a)) continue;
                const re = new RegExp(a, 'g');
                msg = msg.replace(re, symbols[a]);
            }
            return msg;
        };

        /* A message is a log line, parse it into an object with fields.
         *
         * Message format:
         * tttttt Mod TaskName Facility: MessageBody.
         * - TaskName can contain spaces.
         */
        const parseMessage = message => {
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
            var msg = message.slice(pos + 1).trimRight();

            /* When a log message contains symbols definition, I should only
             * extract the definitions without doing the symbol value
             * translation. For example, in a log
             *   ... @Symbols: var_a=100 ...
             * the symbol 'var_a' may still existed in the symbol table, if I
             * do the translation for this log message, it will be printed out
             * as
             *   ... @Symbols: 100=100 ...
             * , which is wrong.
             */
            if (! extractSymbols(msg))
                msg = translateSymbols(msg);

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
                /* The following will print ticks with format of
                 * '..hhh:mm:ss.xxx' instead of rawo millisecons.
                 */
                //var ticks = m.timestamp;
                //var negTime = false;
                //if (ticks >= 0x80000000) {
                //    ticks = 0x100000000 - ticks;
                //    negTime = true;
                //}
                //const hr = parseInt(ticks / 1000 / 3600);
                //ticks -= hr * 3600 * 1000;
                //const min = parseInt(ticks / 1000 / 60);
                //ticks -= min * 60 * 1000;
                //const s = parseInt(ticks / 1000);
                //ticks -= s* 1000;
                //const ms = ticks;

                //const aligned = (n, width, c) => {
                //    const s = '' + n;
                //    return s.padStart(width, c);
                //};
                //m.timestamp = `${negTime ? '-' : ' '}${aligned(hr, 4, '0')}:${aligned(min, 2, '0')}:${aligned(s, 2, '0')}.${aligned(ms, 3, '0')}`;
                
                /* tick format as seconds.
                 */
                m.timestamp = (parseInt(m.timestamp / 1000) + '.').padStart(8, ' ')
                    + (parseInt(m.timestamp % 1000) + '').padStart(3, '0');
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
            info.message = info.message.trimRight();
            if (! info.message) {
                info[MESSAGE] = '';
                return;
            }
            /* info.message must replaced by the fixed version for removing the
             * possible existing binary characters, otherwise, when the parsing
             * fail and the info.message is printed out as raw, it would make the
             * log file being complained by grep for the binary data in it.
             */
            info.message = fixMessage(info.message);
            const m = transformMessage(parseMessage(info.message));
            info[MESSAGE] = `${m.systime} ${m.timestamp} ${m.mod} ${m.task} ${m.facility} ${m.msg}`;
        } catch (error) {
            info[MESSAGE] = `*Error:* ${error.message}. The raw message is: ${info.message}`;
        }
        return info;
    }
})());

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
        stream: fs.createWriteStream(argv.file, { flags: argv.append ? 'a' : 'w' }),
        format: logFormat({ color: false, padding: true }),
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

function startSerialReceive({ device, baud, logger, rawLogger })
{
    const serial = new SerialPort({
        path: argv.device,
        baudRate: argv.baud,
        autoOpen: false,
    }).on('data', makeLogLineHandler(line => {
        if (rawLogger) rawLogger.log(
            `${moment().format('YYYYMMDDThh:mm:ss.SSS')} ${line}`
        );
        logger.info(line);
    }));

    serial.open(err => {
        if (err) {
            console.error(`Error opening ${device}:`, err);
            process.exit(1);
        }
    });
}

function startTcpReceive({ server, port, logger, rawLogger })
{
    const client = new net.Socket();
    client.connect(port, server, () => {
    });
    client.on('data', makeLogLineHandler(line => {
        if (rawLogger) rawLogger.log(
            `${moment().format('YYYYMMDDThh:mm:ss.SSS')} ${line}`
        );
        logger.info(line);
    }));
    client.on('error', err => {
        console.error(err);
    });
    client.on('close', () => {
        process.exit(0);
    });
}

function RawLogger(filename, append) {
    this.ws = fs.createWriteStream(filename, { flags: append ? 'a' : 'w' });
}

RawLogger.prototype.log = function(line) {
    this.ws.write(line + '\n');
}

var rawLogger;
if (argv.raw) rawLogger = new RawLogger(argv.raw, argv.append);

if (! argv.device.search('TCP:')) {
    const server = argv.device.slice('TCP:'.length).split(':')[0];
    const port = +argv.device.slice('TCP:'.length).split(':')[1];
    startTcpReceive({
        server,
        port,
        logger,
        rawLogger,
    });
} else
    startSerialReceive({
        device: argv.device,
        baud: argv.baud,
        logger,
        rawLogger,
    });

