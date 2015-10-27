'use strict';

var spawn = require('child_process').spawn;
var express = require('express');
var Gpio = require('onoff').Gpio;

// pin - GPIO number (see the diagramm), dir -direction (in/out)
var Ports = {
    sensor1: { pin: 22, dir: 'in' },        // Motion sensor #1
    sensor2: { pin: 23, dir: 'in' },        // Motion sensor #2
    sensor3: { pin: 27, dir: 'in' },        // Motion sensor #3
    lightNet:  { pin: 2, dir: 'out' },      // Light on the ground (Net)
    lightDog: { pin: 18, dir: 'out' },      // Dog light
    soundDog: { pin: 17, dir: 'out'},       // Dog sound start
    lightSkull1: { pin: 14, dir: 'out' },   // Skull #1 light
    lightSkull2: { pin: 15, dir: 'out' },   // Skull #2 light
    flashLight1: { pin: 3, dir: 'out' },    // Flash light #1
    flashLight2: { pin: 4, dir: 'out' },    // Flash light #2
};

// Shortcut to turn port on
function portOn(portName, cb) {
    if(Ports[portName].dir === 'out') {
        Ports[portName].gpio.write(1, cb);
    }
}

// Shortcut to turn port off
function portOff(portName, cb) {
    if(Ports[portName].dir === 'out') {
        Ports[portName].gpio.write(0, cb);
    }
}

function init() {
    // Set up pins
    for(var port in Ports) {
        Ports[port].gpio = new Gpio(Ports[port].pin, Ports[port].dir, Ports[port].dir === 'in' ? 'both': 'none');
        console.log('Gpio object was created for ' + port + ' (pin ' + Ports[port].pin + ')');
    }
}

function exit() {
    console.log('Exiting...');
    // Release pins
    for(var port in Ports) {
        if(Ports[port].gpio) {
            Ports[port].gpio.unexport();
        }
    }
    process.exit();
}

function testOutput() {
    portOn('lightNet');
    portOn('lightDog');
    portOn('soundDog');
    portOn('lightSkull1');
    portOn('lightSkull2');
    portOn('flashLight1');
    portOn('flashLight2');
console.log('on');

    setTimeout(function() {
        portOff('lightNet');
        portOff('lightDog');
        portOff('soundDog');
        portOff('lightSkull1');
        portOff('lightSkull2');
        portOff('flashLight1');
        portOff('flashLight2');
console.log('off');

    }, 2000);
}

process.on('SIGINT', exit);
init();

testOutput();
console.log('Done');
