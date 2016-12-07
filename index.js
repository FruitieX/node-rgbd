'use strict';

const _ = require('lodash');
const color = require('tinycolor2');
const path = require('path');
const fs = require('fs');

let config = {
    port: 9009,
    listenAddr: '0.0.0.0',

    patterns: {
        Disabled: null
    },
    activePattern: 'Disabled',
    prevPattern: 'Disabled',
    fadeStart: new Date().getTime(),
    autoBrightness: true,

    fadeTime: 2000,

    strips: [
        {
            numLeds: 90,
            name: 'desk',
            dev: '/dev/ttyACM0',
            baudrate: 1000000, // 32u4 is FAST
            reversed: false,
            header: new Buffer(6),
            colors: [],
            fps: 0,
            fpsLastSample: new Date().getTime(),
            brightness: 1
        }
    ]
};

var readline = require('readline');
var SerialPort = require('serialport');

let fpsAvgFactor = 0.975;

let socketListenerFramerate = 20;

const configPath = path.join(process.env.HOME, '.rgbd-config.json');
const storeConfig = (quit) => {
    console.log('Storing configuration...');
    const omittedConfig = Object.assign({}, config, {
        strips: config.strips.map(strip => (
            _.pick(strip, [
                'numLeds',
                'name',
                'dev',
                'baudrate',
                'reversed',
                'brightness'
            ])
        ))
    });

    //fs.writeFileSync(configPath, JSON.stringify(omittedConfig, '', 4));
    fs.writeFile(configPath, JSON.stringify(omittedConfig, '', 4), () => {
        if (quit) {
            console.log('Quitting...');
            // workaround for nodemon not restarting, used to be process.exit
            process.kill(process.pid, 'SIGUSR2');
        }
    });
};
const storeConfigThrottled = _.throttle(storeConfig, 1000);
const restoreConfig = () => {
    let storedConfig = null;
    try {
        storedConfig = fs.readFileSync(configPath);
        console.log('Restoring config...');

        config = JSON.parse(storedConfig);
        config.strips.forEach(strip => {
            strip.header = new Buffer(6);
            strip.colors = [];
            strip.fps = 0;
            strip.fpsLastSample = new Date().getTime();
        });
    } catch(err) {
        console.log('Unable to restore config:', err.message);
        if (err.code === 'ENOENT') {
            console.log('Writing default config to', configPath);
            storeConfigThrottled();
        }
        return;
    }
};
restoreConfig();

process.once('SIGINT', () => {
    console.log('SIGINT received, saving config');
    storeConfig(true);
});
process.once('SIGUSR2', () => {
    console.log('SIGUSR2 received, saving config');
    storeConfig(true);
});

function dither(c) {
    let rand = Math.random();
    if (c.r !== Math.floor(c.r)) {
        const shouldFloor = rand > (c.r - Math.floor(c.r));
        c.r = shouldFloor ? Math.floor(c.r) : Math.ceil(c.r);
    }
    if (c.g !== Math.floor(c.g)) {
        const shouldFloor = rand > (c.g - Math.floor(c.g));
        c.g = shouldFloor ? Math.floor(c.g) : Math.ceil(c.g);
    }
    if (c.b !== Math.floor(c.b)) {
        const shouldFloor = rand > (c.b - Math.floor(c.b));
        c.b = shouldFloor ? Math.floor(c.b) : Math.ceil(c.b);
    }
    return c;
}

// color calibration function
function calibrate(c) {
    return {
        r: Math.pow(c.r / 255, 2) * 255,
        g: Math.pow(c.g / 255, 2) * 170,
        b: Math.pow(c.b / 255, 2) * 150
    }
}

// initialize strips
config.strips.forEach(function(strip, index) {
    // start with all LEDs off
    strip.colors = Array.from(Array(strip.numLeds)).map(function() {
        return {
            r: 0,
            g: 0,
            b: 0
        };
    });

    // Adalight protocol header
    strip.header.write('Ada', 0, 3, 'ascii');
    // 4th and 5th bytes are high and low bytes respectively of (numLeds - 1)
    strip.header.writeUInt16BE(strip.numLeds - 1, 3);
    // 6th byte is XOR of (numLeds - 1) high, low bytes, then the constant 0x55
    strip.header.writeUInt8(strip.header[3] ^ strip.header[4] ^ 0x55, 5);

    strip.writeColor = function() {
        var buf = new Buffer(6 + strip.numLeds * 3);
        strip.header.copy(buf);

        const pattern = config.patterns[config.activePattern];
        const oldPattern = config.patterns[config.prevPattern];

        let patternStrip = null;
        let oldPatternStrip = null;

        if (!pattern || !pattern[index]) {
            patternStrip = Array.from(Array(strip.numLeds)).map(function() {
                return {
                    r: 0,
                    g: 0,
                    b: 0
                };
            });
        } else {
            patternStrip = pattern[index];
        }

        if (!oldPattern || !oldPattern[index]) {
            oldPatternStrip = Array.from(Array(strip.numLeds)).map(function() {
                return {
                    r: 0,
                    g: 0,
                    b: 0
                };
            });
        } else {
            oldPatternStrip = oldPattern[index];
        }

        for (var i = 0; i < strip.numLeds; i++) {
            let fade = 100 - Math.min(100, (new Date().getTime() - config.fadeStart) / config.fadeTime * 100);

            let c = null;
            if (fade && oldPatternStrip) {
                c = color.mix(color(patternStrip[i]), color(oldPatternStrip[i]), fade);
                c = c.toRgb();
            } else {
                c = Object.assign({}, patternStrip[i]);
            }

            if (config.autoBrightness) {
                const hours = new Date().getHours();
                const min = new Date().getMinutes();
                const sec = new Date().getSeconds();

                const totalSec = min * 60 + sec;
                const fadeInHour = 8;
                const fadeOutHour = 21;

                strip.brightness = 1;

                if (hours < fadeInHour || hours > fadeOutHour) {
                    strip.brightness = 0.2;
                } else if (hours === fadeInHour) {
                    strip.brightness = 0.2 + 0.8 * totalSec / 3600;
                } else if (hours === fadeOutHour) {
                    strip.brightness = 1 - (0.8 * totalSec / 3600);
                }
            }

            c.r *= strip.brightness;
            c.g *= strip.brightness;
            c.b *= strip.brightness;

            strip.colors[i] = c;

            c = calibrate(c);
            c = dither(c);

            buf[6 + (i * 3) + 0] = Math.round(c.r || 0);
            buf[6 + (i * 3) + 1] = Math.round(c.g || 0);
            buf[6 + (i * 3) + 2] = Math.round(c.b || 0);
        }

        if (!strip.dev) {
            return;
        }

        strip.serialPort.write(buf, function() {
            strip.serialPort.drain(function() {
                let newFps =  1 / ((new Date().getTime() - strip.fpsLastSample) / 1000);
                strip.fpsLastSample = new Date().getTime();
                strip.fps = fpsAvgFactor * strip.fps + (1 - fpsAvgFactor) * newFps;

                process.nextTick(strip.writeColor);
            });
        });
    };

    strip.openSerialPort = function(err) {
        if (!strip.dev) {
            console.log('WARNING: not opening null serialport!');
            setInterval(strip.writeColor, 10);
        } else if (strip.serialPort) {
            strip.serialPort.close(function() {
                strip.serialPort = null;
                setTimeout(strip.openSerialPort, 1000);
            });
        } else {
            strip.serialPort = new SerialPort(strip.dev, {
                autoOpen: false,
                baudrate: strip.baudrate,
                dataBits : 8,
                parity : 'none',
                stopBits: 1,
                flowControl : false
            });

            strip.serialPort.on('error', function(err) {
                setTimeout(function() {
                    console.log(strip.name + ' serial port error: ' + err);
                    console.log(strip.name + ' retrying in 1000 ms...');
                    strip.openSerialPort();
                }, 1000);
            });
            strip.serialPort.open(function(err) {
                if (err) {
                    console.log(strip.name + ' failed to open serial: ' + err);
                    console.log(strip.name + ' retrying in 1000 ms...');
                    strip.openSerialPort();
                } else {
                    strip.lineReader = readline.createInterface({
                        input: strip.serialPort
                    });
                    strip.lineReader.on('line', function(line) {
                        if (line === 'Ada') {
                            console.log(strip.name + ' got ACK string');
                            strip.writeColor();
                        } else {
                            console.log(strip.name + ' ' + line);
                        }
                    });
                    console.log(strip.name + ' serial opened');
                }
            });
        }
    };

    strip.openSerialPort();
});

var http = require('http');
var server = http.createServer();
var io = require('socket.io')(server);
server.listen(config.port, config.listenAddr);

console.log('rgbd socket.io server listening on port', config.port);

io.on('connection', function(socket) {
    // emit existing patterns right away
    // TODO: refactor into bundled state updates
    socket.emit('patterns', _.keys(config.patterns));
    socket.emit('activate', config.activePattern);
    socket.emit('autoBrightness', config.autoBrightness);

    socket.on('frame', function(frame) {
        if (!config.strips[frame.id]) {
            console.log('invalid strip id: ' + frame.id);
            socket.emit('err', 'invalid strip id: ' + frame.id +
                               ', max is: ' + config.strips.length - 1);
            return;
        }

        if (!frame.name) {
            console.log('must provide frame name!');
            socket.emit('err', 'must provide frame name!');
            return;
        }

        // TODO clean up on disconnect
        if (!config.patterns[frame.name]) {
            config.patterns[frame.name] = [];
            socket.broadcast.emit('patterns', _.keys(config.patterns));
        }

        config.patterns[frame.name][frame.id] = frame.colors;

        if (config.strips[frame.id].reversed) {
            config.patterns[frame.name][frame.id].reverse();
        }
    });

    socket.on('prevPattern', function(skipPattern) {
        // Don't change to skipPattern if specified
        if (config.prevPattern === skipPattern) {
            return;
        }

        if (!config.patterns[config.prevPattern]) {
            return console.log('Not changing to unknown pattern:', config.prevPattern);
        }

        console.log('Activating previous pattern:', config.prevPattern, 'active was:', config.activePattern);
        // Activate previous pattern
        const temp = config.prevPattern;
        config.prevPattern = config.activePattern;
        config.activePattern = temp;
        storeConfigThrottled();

        config.fadeStart = new Date().getTime();
        socket.broadcast.emit('activate', temp);
    });

    socket.on('activate', function(name) {
        // Pattern already active
        if (name === config.activePattern) {
            return;
        }

        if (!config.patterns[name]) {
            return console.log('Not changing to unknown pattern:', name);
        }

        console.log('Activating pattern:', name, 'previous was:', config.prevPattern);
        config.prevPattern = config.activePattern;
        config.activePattern = name;
        storeConfigThrottled();

        config.fadeStart = new Date().getTime();
        socket.broadcast.emit('activate', name);
    });

    socket.on('stripsSubscribe', function() {
        socket.join('strips');
    });
    socket.on('setBrightness', function(data) {
        if (!config.strips[data.index]) {
            return;
        }

        config.strips[data.index].brightness = data.value;
        storeConfigThrottled();
    });
    socket.on('autoBrightness', function(value) {
        config.autoBrightness = value;
        storeConfigThrottled();
        socket.broadcast.emit('autoBrightness', config.autoBrightness);
    });
});

setInterval(() => {
    let emittedStrips = config.strips.map(strip => {
        let picked =_.pick(strip, [
            'numLeds',
            'name',
            'dev',
            'fps',
            'baudrate',
            'reversed',
            'colors',
            'brightness'
        ]);

        picked.patterns = _.keys(config.patterns);

        picked.colors = picked.colors.map(colors => {
            return {
                r: Math.round(colors.r),
                g: Math.round(colors.g),
                b: Math.round(colors.b),
            };
        });

        return picked;
    });

    io.to('strips').emit('strips', emittedStrips);
}, 1000 / socketListenerFramerate);
