'use strict';

const _ = require('lodash');
const color = require('tinycolor2');

var port = 9009;
var listenAddr = '0.0.0.0';

var patterns = {};
var activePattern = null;
var prevPattern = null;
var fadeTime = new Date().getTime();

var strips = [
    {
        numLeds: 90,
        name: 'desk',
        dev: null,
        baudrate: 1000000, // 32u4 is FAST
        reversed: false,
        header: new Buffer(6),
        colors: [],
        fps: 0,
        fpsLastSample: new Date().getTime(),
        brightness: 1
    }
];

var readline = require('readline');
var SerialPort = require('serialport');

let fpsAvgFactor = 0.975;

let socketListenerFramerate = 20;

// initialize strips
strips.forEach(function(strip, index) {
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

        const pattern = patterns[activePattern];
        const oldPattern = patterns[prevPattern];

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
            let fade = 100 - Math.min(100, (new Date().getTime() - fadeTime) / 25);

            let c = null;
            if (fade && oldPatternStrip) {
                c = color.mix(color(patternStrip[i]), color(oldPatternStrip[i]), fade);
                c = c.toRgb();
            } else {
                c = Object.assign({}, patternStrip[i]);
            }

            c.r *= strip.brightness;
            c.g *= strip.brightness;
            c.b *= strip.brightness;

            strip.colors[i] = c;

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
server.listen(port, listenAddr);

console.log('rgbd socket.io server listening on port 9009');

io.on('connection', function(socket) {
    // emit existing patterns right away
    socket.emit('patterns', _.keys(patterns));
    socket.emit('activate', activePattern);

    socket.on('frame', function(frame) {
        if (!strips[frame.id]) {
            console.log('invalid strip id: ' + frame.id);
            socket.emit('err', 'invalid strip id: ' + frame.id +
                               ', max is: ' + strips.length - 1);
            return;
        }

        if (!frame.name) {
            console.log('must provide frame name!');
            socket.emit('err', 'must provide frame name!');
            return;
        }

        // TODO clean up on disconnect
        if (!patterns[frame.name]) {
            patterns[frame.name] = [];
            socket.broadcast.emit('patterns', _.keys(patterns));
        }

        patterns[frame.name][frame.id] = frame.colors;

        if (strips[frame.id].reversed) {
            patterns[frame.name][frame.id].reverse();
        }
    });

    socket.on('activate', function(name) {
        prevPattern = activePattern;
        activePattern = name;
        fadeTime = new Date().getTime();

        socket.broadcast.emit('activate', name);
    });

    socket.on('stripsSubscribe', function() {
        socket.join('strips');
    });
    socket.on('setBrightness', function(data) {
        if (!strips[data.index]) {
            return;
        }

        strips[data.index].brightness = data.value;
    });
});

setInterval(() => {
    let emittedStrips = strips.map(strip => {
        let omitted = _.omit(strip, [ 'header' ]);

        omitted.patterns = _.keys(patterns);

        return omitted;
    });

    io.to('strips').emit('strips', emittedStrips);
}, 1000 / socketListenerFramerate);
