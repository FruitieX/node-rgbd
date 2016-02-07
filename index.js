'use strict';

var numLeds = 91;
var baudrate = 1000000; // 32u4 is FAST
var port = 9009;

var http = require('http');
var server = http.createServer();
var io = require('socket.io')(server);
server.listen(port, 'localhost');

console.log('rgbd socket.io server listening on port 9009');

var SerialPort = require('serialport').SerialPort;

// Adalight protocol header
var header = new Buffer(6);
header.write('Ada', 0, 3, 'ascii');
header.writeUInt16BE(numLeds - 1, 3); // number of leds - 1
header.writeUInt8(header[3] ^ header[4] ^ 0x55, 5); // xor of numLeds high, low bytes, then 0x55

var colors = [];
for (var i = 0; i < numLeds; i++) {
    colors[i] = {
        red: 255,
        green: 255,
        blue: 255
    };
}

io.on('connection', function(socket) {
    socket.on('frame', function(frame) {
        colors = frame;
    });
    socket.on('led', function(data) {
        colors[data.led] = data.colors;
    });
});

var writeColor = function() {
    var buf = new Buffer(6 + numLeds * 3);
    header.copy(buf);

    for (var i = 0; i < numLeds; i++) {
        if (!colors[i]) {
            continue;
        }
        buf[6 + (i * 3) + 0] = Math.round(colors[i].red || 0);
        buf[6 + (i * 3) + 1] = Math.round(colors[i].green || 0);
        buf[6 + (i * 3) + 2] = Math.round(colors[i].blue || 0);
    }

    serialPort.write(buf, function() {
        serialPort.drain(function() {
            process.nextTick(writeColor);
        });
    });
};

var readline = require('readline');
var lineReader;

var serialPort = null;
var openSerialPort = function(err) {
    if (serialPort) {
        serialPort.close(function() {
            serialPort = null;
            setTimeout(openSerialPort, 1000);
        });
    } else {
        serialPort = new SerialPort('/dev/ttyACM0', {
            baudrate: baudrate,
            dataBits : 8,
            parity : 'none',
            stopBits: 1,
            flowControl : false
        }, false);

        serialPort.on('error', function(err) {
            setTimeout(function() {
                console.log('serial port error: ' + err);
                console.log('retrying in 1000 ms...');
                openSerialPort();
            }, 1000);
        });
        serialPort.open(function(err) {
            if (err) {
                console.log('failed to open serial: ' + err);
                console.log('retrying in 1000 ms...');
                openSerialPort();
            } else {
                lineReader = readline.createInterface({
                    input: serialPort
                });
                lineReader.on('line', function(line) {
                    if (line === 'Ada') {
                        console.log('got ACK string');
                        writeColor();
                    } else {
                        console.log(line);
                    }
                });
                console.log('serial opened');
            }
        });
    }
};

openSerialPort();
