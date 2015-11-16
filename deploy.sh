#!/bin/bash

DST=pi@192.168.0.150:/opt/halloween

scp -r static halloween.js sound2.mp3 $DST
