'use strict';

var port = 9009;
var listenAddr = 'localhost';

var strips = [
    {
        numLeds: 91,
        name: 'desk',
        dev: '/dev/ttyACM0',
        baudrate: 1000000, // 32u4 is FAST
        reversed: true,
        header: new Buffer(6),
        colors: [],
        oldColors: []
    }
    /*
    {
        numLeds: 11,
        name: 'monitor',
        dev: '/dev/ttyUSB1',
        baudrate: 38400, // 328 not so much
        reversed: true,
        header: new Buffer(6),
        colors: []
    }
    */
];

var readline = require('readline');
var SerialPort = require('serialport');

var color = require('tinycolor2');

var fadeTime = new Date().getTime();

// initialize strips
strips.forEach(function(strip) {
    // start with all LEDs off
    strip.colors = Array.from(Array(strip.numLeds)).map(function() {
        return {
            r: 0,
            g: 0,
            b: 0
        };
    });
    strip.oldColors = Array.from(Array(strip.numLeds)).map(function() {
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

        for (var i = 0; i < strip.numLeds; i++) {
            if (!strip.colors[i]) {
                continue;
            }

            let fade = 100 - Math.min(100, (new Date().getTime() - fadeTime) / 25);
            let c = null;

            if (fade) {
                c = color.mix(color(strip.colors[i]), color(strip.oldColors[i]), fade);
                c = c.toRgb();
            } else {
                c = strip.colors[i];
            }

            buf[6 + (i * 3) + 0] = Math.round(c.r || 0);
            buf[6 + (i * 3) + 1] = Math.round(c.g || 0);
            buf[6 + (i * 3) + 2] = Math.round(c.b || 0);
        }

        strip.serialPort.write(buf, function() {
            strip.serialPort.drain(function() {
                process.nextTick(strip.writeColor);
            });
        });
    };

    strip.openSerialPort = function(err) {
        if (strip.serialPort) {
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
    fadeTime = new Date().getTime();
    strips.forEach(strip => {
        strip.oldColors = strip.colors.slice(0);
    });

    socket.on('frame', function(frame) {
        if (!strips[frame.id]) {
            console.log('invalid strip id: ' + frame.id);
            socket.emit('error', 'invalid strip id: ' + frame.id +
                                 ', max is: ' + strips.length - 1);
        }

        strips[frame.id].colors = frame.colors;
        if (strips[frame.id].reversed) {
            strips[frame.id].colors.reverse();
        }
    });
});
