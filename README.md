# plogread
Picasso Log Reader

## Installation

  1. Install NodeJs in your OS.
  2. CD into the root directory of this package.
  3. Run `npm install` to install dependencies.

## Usage

The following command line read and print the log and save the logs to a file at the same time:

  - Linux: `./bin/plogread -d /dev/ttyUSB0 -f foo.log`
  - Windows: `node plogread -d COM3 -w log`

For detail information, run `plogread -h` to get the online help. Below is a
screenshot when running the above command line:

<img src="doc/screenshot.png" alt="screenshot" width="500"/>

## Log File Max Size

By default, the log file will automatically split once it reaached size of 10M.
The size limit can be configured by '-s N', where N is in Kilo-byte.
