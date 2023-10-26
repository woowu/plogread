# plogread
Picasso Log Reader

## Installation

  1. Install NodeJs in your OS.
  2. CD into the root directory of this package.
  3. Run `npm install` to install dependencies.

## Usage

### Receive logs

The following command line read and print the log and save the logs to a file at the same time:

  - Linux: `./bin/plogread -d /dev/ttyUSB0 -f foo.log`
  - Windows: `node bin\plogread -d COM3 -f foo.log`

Device can be a TCP port, for example,

  - `./bin/plogread -d 10.86.11.208:4059 -f foo.log`

For detail information, run `plogread -h` to get the online help. Below is a
screenshot when running the above command line:

<img src="doc/screenshot.png" alt="screenshot" width="500"/>

## Log File Max Size

By default, the log file will automatically split once it reaached size of 10M.
The size limit can be configured by '-s N', where N is in Kilo-byte.

### Analyze logs

  - ./bin/ploga -f foo.log stat



