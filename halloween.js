/**
 * Halloween installation module
 * Denis Volkov (C) 2015
 */
'use strict';

var spawn = require('child_process').spawn;
var express = require('express');
var bodyParser = require('body-parser');
var fs = require("fs");
var Gpio = require('onoff').Gpio;

// Sensor setup time
var SENSOR_SETUP_TIME = 30000;
// How long a sensor should be active to trigger the action
var SENSOR_TIMEOUT = 5000;
// Start delay - sensor should be active during this time
var START_DELAY = 4000;
// Flash interval
var FLASH_INTERVAL = 2000;
// Flash duration
var FLASH_DURATION = 500;

// Cool down duration
var COOL_DOWN_DURATION = 90000;

// Specific timings
var DOG_ON_DURATION = 16000;
var DOG_OFF_DURATION = 15000;
var DOG_TRANSITION = 2000;

var SKULL1_ON_DURATION = 2000;
var SKULL1_OFF_DURATION = 1500;
var SKULL1_TRANSITION = 1500;

var SKULL2_ON_DURATION = 3000;
var SKULL2_OFF_DURATION = 2000;
var SKULL2_TRANSITION = 1500;

var SOUND_PLAYER_CMD = 'omxplayer';
var SOUND_PLAYER_ARGS = ['-o', 'local', 'sound2.mp3'];
var SOUND_PLAYER_ARGS_MUTE = ['--vol', '-6000'].concat(SOUND_PLAYER_ARGS);
var SOUND_PLAYER_OPTIONS = { cwd: '/opt/halloween' };

var PIGPIO_PIPE_NAME = '/dev/pigpio'

// PWM cycle length (ms)
var PWM_PRECISION = 10;

// Transition interval
var TRANSITION_INTERVAL = 40;

// pin - GPIO number (see the diagramm), dir -direction (in/out)
var Ports = {
    sensor1: { pin: 22, dir: 'in' },        // Motion sensor #1
    sensor2: { pin: 23, dir: 'in' },        // Motion sensor #2
    sensor3: { pin: 27, dir: 'in' },        // Motion sensor #3
    lightNet:  { pin: 2, dir: 'out', invert: true },      // Light on the ground (Net) - active 0
    lightDog: { pin: 18, dir: 'out' },      // Dog light
    soundDog: { pin: 17, dir: 'out'},       // Dog sound start
    lightSkull1: { pin: 14, dir: 'out' },   // Skull #1 light
    lightSkull2: { pin: 15, dir: 'out' },   // Skull #2 light
    flashLight1: { pin: 3, dir: 'out' },    // Flash light #1
    flashLight2: { pin: 4, dir: 'out' },    // Flash light #2
};

// State object for Web API
var State = {
    mode: 'idle',
    sensor1: false,
    sensor2: false,
    sensor3: false,
    lightNet: 0,
    lightDog: 0,
    lightSkull1: 0,
    lightSkull2: 0,
    soundDog: 0
};

var IOEnabled = {
    sensor1: true,
    sensor2: true,
    sensor3: true,
    music: true
}

var startTime = new Date().getTime();

// Shortcut to turn port on
function portOn(portName, cb) {
    if(Ports[portName].dir === 'out') {
        Ports[portName].gpio.write(Ports[portName].invert ? 0: 1, cb);
    }
}

// Shortcut to turn port off
function portOff(portName, cb) {
    if(Ports[portName].dir === 'out') {
        Ports[portName].gpio.write(Ports[portName].invert ? 1 : 0, cb);
    }
}

// Set PWM for @portName with @value (0 to 1, 0 means off)
function portPWM(portName, value, cb) {
    if(Ports[portName].pin) {
        sendPigpioCommand('p ' + Ports[portName].pin + ' ' + Math.floor(value * 250), cb);
    }
}

function sendPigpioCommand(cmd, cb) {
    fs.open(PIGPIO_PIPE_NAME, 'w', function(err, pipe) {
        if(err) {
            console.log("Cannot open pigpio pipe - check that daemon is running");
            process.exit(1);
        } else {
            fs.write(pipe, cmd + '\n', function(err) {
                if(err) {
                    console.log("Cannot write pigpio command, error " + err);
                    fs.close(pipe);
                    cb && cb(err);
                } else {
                    // console.log('Command sent: ' + cmd);
                    fs.close(pipe);
                    cb && cb();
                }
            });
        }

    });
}

function curtime() {
    return new Date().getTime();
}

// Sensor watch object
function SensorWatch(sensorName, cb) {
    var that = this;
    this._stateTimeout = null;

    Ports[sensorName].gpio.watch(function(err, data) {
        if(data) {
            if(!State[sensorName]) {
                State[sensorName] = true;
                if(that._stateTimeout) {
                    clearTimeout(that._stateTimeout);
                }
                that._stateTimeout = setTimeout(cb, SENSOR_TIMEOUT);
            }
        } else {
            State[sensorName] = false;
            if(that._stateTimeout) {
                clearTimeout(that._stateTimeout);
                that._stateTimeout = null;
            }
        }
    });

    this.getState = function() {
        return State[sensorName];
    }
}

// Sensor array object
function SensorArray(cb) {
    var that = this;

    function callback() {
        if(that.getState()) {
            cb && cb();
        }
    }

    var watch1 = new SensorWatch('sensor1', callback);
    var watch2 = new SensorWatch('sensor2', callback);
    var watch3 = new SensorWatch('sensor3', callback);

    this.getState = function() {
        return (IOEnabled.sensor1 && watch1.getState()) ||
            (IOEnabled.sensor2 && watch2.getState()) ||
            (IOEnabled.sensor3 && watch3.getState());
    };
}

function Flasher() {
    var that = this;
    this._interval = null;
    this._curChannel = 1;

    function flashOff() {
        portOff('flashLight' + that._curChannel);
        // Flip-flop between channels 1 and 2
        that._curChannel = 3 - that._curChannel;
    }

    function flashOn() {
        // Turn channel on
        portOn('flashLight' + that._curChannel);
        // Tunr channel off after the timeout
        setTimeout(flashOff, FLASH_DURATION);
    }

    this.start = function() {
        this.stop();
        this._interval = setInterval(flashOn, FLASH_INTERVAL);
    }
    this.stop = function() {
        if(this._interval) {
            clearInterval(this._interval);
            this._interval = null;
        }
    }
}

function SlowFlasher(channelName, timeOn, timeOff, transitionTable, stateCallback) {
    var that = this;
    this._transitionCount = 0;
    this._transitionInterval = null;
    this._stateTimeout = null;
    this._stopFlag = true;

    function channelOn() {
        portOn(channelName);
    }

    function channelOff() {
        portOff(channelName);
    }

    function transitionStep() {
        if(!State[channelName]) {
            channelOn();
        } else {
            channelOff();
        }

        if(that._transitionCount < transitionTable.length) {
            if(!State[channelName]) {
                setTimeout(channelOff, transitionTable[that._transitionCount]);
            } else {
                setTimeout(channelOn, transitionTable[that._transitionCount]);
            }
            that._transitionCount ++;
        } else {
            State[channelName] = State[channelName] ? 0 : 1;
            clearInterval(that._transitionInterval);
            that._transitionInterval = null;
            if(!that._stopFlag || State[channelName]) {
                that._stateTimeout = setTimeout(runTransition, (State[channelName] ? timeOn : timeOff));
            }
            stateCallback && stateCallback();
        }
    }

    function runTransition() {
        that._transitionCount = 0;
        if(that._transitionInterval) {
            clearInterval(that._transitionInterval);
        }
        that._transitionInterval = setInterval(transitionStep, PWM_PRECISION);
    }

    this.start = function() {
        console.log('Starting ' + channelName);
        channelOff();
        State[channelName] = 0;
        if(this._stateTimeout) {
            clearTimeout(this._stateTimeout);
            this._stateTimeout = null;
        }
        this._stopFlag = false;
        runTransition();
    }

    this.stop = function() {
        console.log('Stopping ' + channelName);
        // If flash is off and in the wait cycle, just stop cycle
        if(this._stateTimeout && !State[channelName]) {
            clearTimeout(this._stateTimeout);
            this._stateTimeout = null;
        }
        // Need to finish a cycle
        this._stopFlag = true;
    }
}

/**
 * Create the transition table
 * @duration (ms) - duration of transition
 */
function createTransitionTable(duration) {
    var table = [];
    var steps = duration / PWM_PRECISION;
    for(var n = 0; n < steps; ++ n) {
        table.push(Math.round((n / steps * 0.8 + 0.1) * PWM_PRECISION));
    }

    return table;
}

// Slow Flasher (pigpio version)
function SlowFlasherPigpio(channelName, timeOn, timeOff, timeTransition, stateCallback) {
    var that = this;
    this._transitionStartTime = 0;
    this._transitionInterval = null;
    this._stateTimeout = null;
    this._stopFlag = true;

    function endTansition(err) {
        if(!err) {
            if(!State[channelName]) {
                portOn(channelName);
                State[channelName] = 1;
            } else {
                portOff(channelName);
                State[channelName] = 0;
            }
            clearInterval(that._transitionInterval);
            that._transitionInterval = null;
            if(!that._stopFlag || State[channelName]) {
                that._stateTimeout = setTimeout(runTransition, (State[channelName] ? timeOn : timeOff));
            }
            stateCallback && stateCallback();
        }
    }

    function transitionStep() {
        var elapsed = curtime() - that._transitionStartTime;
        if(elapsed < timeTransition) {
            if(!State[channelName]) {
                portPWM(channelName, elapsed / timeTransition);
            } else {
                portPWM(channelName, 1 - elapsed / timeTransition);
            }
        } else {
            portPWM(channelName, 0, endTansition);
        }
    }

    function runTransition() {
        that._transitionStartTime = curtime();
        if(that._transitionInterval) {
            clearInterval(that._transitionInterval);
        }
        that._transitionInterval = setInterval(transitionStep, TRANSITION_INTERVAL);
    }

    this.start = function() {
        console.log('Starting ' + channelName);
        portOff(channelName);
        State[channelName] = 0;
        if(this._stateTimeout) {
            clearTimeout(this._stateTimeout);
            this._stateTimeout = null;
        }
        this._stopFlag = false;
        runTransition();
    }

    this.stop = function() {
        console.log('Stopping ' + channelName);
        // If flash is off and in the wait cycle, just stop cycle
        if(this._stateTimeout && !State[channelName]) {
            clearTimeout(this._stateTimeout);
            this._stateTimeout = null;
        }
        // Need to finish a cycle
        this._stopFlag = true;
    }
}

function init() {
    // Set up pins
    for(var port in Ports) {
        Ports[port].gpio = new Gpio(Ports[port].pin, Ports[port].dir, Ports[port].dir === 'in' ? 'both': 'none');
        portOff(port);
        console.log('Gpio object was created for ' + port + ' (pin ' + Ports[port].pin + ')');
    }
}

function exit() {
    console.log('Exiting...');
    // Release pins
    for(var port in Ports) {
        if(Ports[port].gpio) {
            if(Ports[port].dir == 'out') {
                Ports[port].gpio.writeSync(Ports[port].invert ? 1 : 0);
                console.log('Port ' + port + ' turned off');
            }
        }
    }
    process.exit();
}

// Run the app
(function() {
    process.on('SIGINT', exit);
    init();

    State.mode = 'idle';

    var startFlasher1Timeout = null, startFlasher2Timeout = null;
    var playerProcess = null;

    // Start performance function
    function startPerformance(force) {
        console.log('startPerformance is called, force=' + force);
        if(force) {
            // Start immediately
            State.mode = 'run';
            flasher.stop();
            portOn('lightNet');
            State.lightNet = 1;

            // Run slow flashers
            dogFlasher.start();
            startFlasher1Timeout = setTimeout(function() {
                skull1Flasher.start();
                startFlasher1Timeout = null;
            }, Math.floor(Math.random() * 3000));
            startFlasher2Timeout = setTimeout(function() {
                skull2Flasher.start()
                startFlasher2Timeout = null;
            }, Math.floor(Math.random() * 3000));

            // Start playing the theme
            playerProcess = spawn(SOUND_PLAYER_CMD,
                IOEnabled.music ? SOUND_PLAYER_ARGS : SOUND_PLAYER_ARGS_MUTE,
                SOUND_PLAYER_OPTIONS);
            playerProcess.on('close', function(code) {
                console.log('Player exited: ' + code);
                playerProcess = null;
                stopPerformance();
                State.mode = 'cool-down';
                setTimeout(function() {
                    State.mode = 'idle';
                }, COOL_DOWN_DURATION);
            });


        } else if(State.mode === 'idle') {
            State.mode = 'delay';
            // Turn on the net
            portOn('lightNet');
            State.lightNet = 1;

            // Start delay timer
            setTimeout(function() {
                if(sensors.getState()) {
                    startPerformance(true);
                } else {
                    State.mode = 'idle';
                    stopPerformance();
                }
            }, START_DELAY);
        }
    }

    // Stop performance function
    function stopPerformance() {
        console.log('stopPerformance is called');
        // Stop sound playing
        if(playerProcess) {
            //playerProcess.kill('SIGKILL');
            playerProcess.stdin.write('q');
            playerProcess = null;
            console.log('Stopped music player');
        }

        // Turn all channels off
        portOff('lightNet');
        State.lightNet = 0;

        flasher.start();
        dogFlasher.stop();
        if(startFlasher1Timeout) {
            clearTimeout(startFlasher1Timeout);
            startFlasher1Timeout = null;
        } else {
            skull1Flasher.stop();
        }
        if(startFlasher2Timeout) {
            clearTimeout(startFlasher2Timeout);
            startFlasher2Timeout = null;
        } else {
            skull2Flasher.stop();
        }
    }

    // Control dog sound according dog light
    function controlDogSound() {
        if(State.lightDog) {
            portOn('soundDog');
            State.soundDog = 1;
        } else {
            portOff('soundDog');
            State.soundDog = 0;
        }
    }

    // Start watiching sensors with a setup delay
    var sensors = null;
    setTimeout(function() {
        sensors = new SensorArray(startPerformance);
    }, SENSOR_SETUP_TIME);

    var flasher = new Flasher();
    flasher.start();

/*
    var skull1Flasher = new SlowFlasher('lightSkull1',
        SKULL1_ON_DURATION,
        SKULL1_OFF_DURATION,
        createTransitionTable(SKULL1_TRANSITION));

    var skull2Flasher = new SlowFlasher('lightSkull2',
        SKULL2_ON_DURATION,
        SKULL2_OFF_DURATION,
        createTransitionTable(SKULL2_TRANSITION));

    var dogFlasher = new SlowFlasher('lightDog',
        DOG_ON_DURATION,
        DOG_OFF_DURATION,
        createTransitionTable(DOG_TRANSITION),
        controlDogSound);
*/
    var skull1Flasher = new SlowFlasherPigpio('lightSkull1',
        SKULL1_ON_DURATION,
        SKULL1_OFF_DURATION,
        SKULL1_TRANSITION);

    var skull2Flasher = new SlowFlasherPigpio('lightSkull2',
        SKULL2_ON_DURATION,
        SKULL2_OFF_DURATION,
        SKULL2_TRANSITION);

    var dogFlasher = new SlowFlasherPigpio('lightDog',
        DOG_ON_DURATION,
        DOG_OFF_DURATION,
        DOG_TRANSITION
//        , controlDogSound
    );

    // Start web server
    var app = express();
    app.use(express.static('static'));
    app.use(bodyParser.json());
    app.use(bodyParser.urlencoded({ extended: true }));
    app.get('/status', getStatus);
    app.post('/start', postStart);
    app.post('/stop', postStop);
    app.post('/enabled', postEnabled);

    app.listen(4080);
    console.log('HTTP server is started');

    function getStatus(req, res) {
        State.uptime = Math.floor((new Date().getTime() - startTime)/1000);
        res.json(State);
    }

    function postStart(req, res) {
        if(State.mode != 'run') {
            startPerformance(true);
        }
        res.json({ status: 'OK' });
    }

    function postStop(req, res) {
        if(State.mode == 'run') {
            stopPerformance();
            State.mode = 'idle';
        }
        res.json({ status: 'OK' });
    }

    function postEnabled(req, res) {
        var data = req.body;
        for(var pin in IOEnabled) {
            if(data[pin] !== undefined) {
                IOEnabled[pin] = (data[pin] === 'true');
                console.log('IO ' + pin + ' is ' + (IOEnabled[pin] ? 'enabled' : 'disabled'));
            }
        }
    }

})();
