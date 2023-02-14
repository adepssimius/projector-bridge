process.on('uncaughtException', err => {
  console.log(err);
  process.exit(-1);
});
​

const pushoverToken = 'abc123';
const pushoverUser = 'abc123';

const mqttHost = '127.0.0.1';
const mqttTopic = 'projector';

const serialPort = '/dev/ttyUSB0';
const serialBaudRate = 9600;

////////////
​
const Pushover = require('node-pushover-client');
const pushoverClient = new Pushover({
  token: pushoverToken,
  user: pushoverUser,
});
​
/////////
​
var SerialPort = require('serialport');
var port = new SerialPort(serialPort, {
  baudRate: serialBaudRate,
  // autoOpen: false
});
​
var projectorIsTransitioning = false;
var projectorWasOn = false;
​
var serialCmdCount = 0;
var serialCmdQueue = [];
var serialCmdResponseTimeout = null;
var buffer = '';
var isCheckingPower = false;
​
port.on('error', function(err) {
  console.log('Error: ', err.message);
});
​
port.on('data', function(data) {
  console.log(data);
​
  data = data.toString('utf8');
​
  // console.log('data', JSON.stringify(data));
​
  if (data == '\0')
    return;
​
  if (serialCmdQueue.length == 0)
    return log('port got data we did not expect:', data.replace(/\r/g, '\\r').replace(/\n/g, '\\n'));
​
  buffer += data;
  if (buffer.length < serialCmdQueue[0].cmd.length + 6 /* a leading >, a mid \r\r\n, and a trailing \r\n */)
    return; // log('port got partial data (1) for cmd %d with length', serialCmdQueue[0].id, buffer.length, JSON.stringify(buffer));
  if (buffer.substr(-3) == '\r\n\0')
    buffer = buffer.substr(0, buffer.length - 1);
  if (buffer.substr(-2) != '\r\n')
    return; // log('port got partial data (2) for cmd %d with length', serialCmdQueue[0].id, buffer.length, JSON.stringify(buffer));
​
  if (serialCmdResponseTimeout) {
    clearTimeout(serialCmdResponseTimeout);
    serialCmdResponseTimeout = null;
  }
​
  var queuedCmd = serialCmdQueue.shift();
  var completeBuffer = buffer;
  buffer = '';
​
  var matchPrefix = '>' + queuedCmd.cmd + '\r\r\n';
  if (completeBuffer.substr(0, matchPrefix.length) != matchPrefix)
    return log('port data did not match expected prefix for cmd %d', queuedCmd.id, JSON.stringify(completeBuffer));
​
  completeBuffer = completeBuffer.substr(matchPrefix.length).trim();
  log('port got response for cmd %d:', queuedCmd.id, JSON.stringify(completeBuffer));
  queuedCmd.callback(completeBuffer);
​
  if (serialCmdQueue.length > 0)
    writeNextSerialCmd();
});
​
port.on('open', function() {
  console.log('port opened');
  setInterval(checkPower, 3000);
});
​
function serialSendCmd(cmd, callback) {
  var id = ++serialCmdCount;
  log('queueing cmd %d:', id, cmd);
  serialCmdQueue.push({ id, cmd, callback });
  if (serialCmdQueue.length == 1)
    writeNextSerialCmd();
}
​
function writeNextSerialCmd() {
  var queuedCmd = serialCmdQueue[0];
  log('writing cmd %d', queuedCmd.id);
  port.write('\r' + queuedCmd.cmd + '\r');
  serialCmdResponseTimeout = setTimeout(skipCommand, 1000);
}
​
function skipCommand() {
  serialCmdResponseTimeout = null;
  serialCmdQueue.shift();
  if (serialCmdQueue.length > 0)
    writeNextSerialCmd();
}
​
function log() {
  arguments[0] = '[' + new Date().toISOString() + '] ' + arguments[0];
  console.log.apply(console, arguments);
}
​
let pcTimeout = null;
function checkPower() {
  if (isCheckingPower) return;
​
  pcTimeout = setTimeout(() => {
    isCheckingPower = false;
    process.nextTick(checkPower);
  }, 10000);
​
  isCheckingPower = true;
​
  serialSendCmd('*pow=?#', function(response) {
    isCheckingPower = false;
    clearTimeout(pcTimeout);
​
    if (response == '*Block item#') {
      if (projectorIsTransitioning) return;
      projectorIsTransitioning = true;
      projectorIsOn = !projectorWasOn;
      updateProjectorState(projectorIsOn);
      return;
    }
​
    projectorIsTransitioning = false;
    var result = response.match(/^\*POW=([^#]+)/);
    var powerResult = result[1];
    var projectorIsOn = powerResult == 'ON';
    if (projectorIsOn != projectorWasOn) {
      projectorWasOn = projectorIsOn;
      updateProjectorState(projectorIsOn);
      return;
    }
​
    publishCurrentProjectorState(projectorWasOn);
  });
}
​
​
/////////////
​
​
const mqtt = require('async-mqtt');
​
const mclient = mqtt.connect('mqtt://' + mqttHost);
​
mclient.on('error', err => {
    console.log('mqtt error', err);
    process.exit(-1);
});
​
mclient.on('connect', async () => {
    console.log('mqtt connected');
    await mclient.subscribe(mqttTopic + '/set');
    console.log('mqtt subscribed');
});
​
mclient.on('message', async (topic, message) => {
    message = message.toString();
    console.log('mqtt got message', topic, message);
​
    if (projectorIsTransitioning) {
      console.log('already transitioning');
      return;
    }
​
    if (message === 'ON') {
      serialSendCmd('*pow=on#', () => {
        updateProjectorState(true);
      });
    } else if (message === 'OFF') {
      serialSendCmd('*pow=off#', async () => {
        await delay(1000);
        serialSendCmd('*pow=off#', function() {
          updateProjectorState(false);
        });
      });
    } else {
        console.log('unreachable code');
    }
});
​
​
/////////////
​
function updateProjectorState(projectorIsOn) {
  mclient.publish(mqttTopic + '/state', projectorIsOn ? 'ON' : 'OFF', { retain: true });
  pushoverClient.send({ message: 'Projector is ' + (projectorIsOn ? 'on' : 'off') + '.' });
}
​
function publishCurrentProjectorState(projectorIsOn) {
  mclient.publish(mqttTopic + '/state', projectorIsOn ? 'ON' : 'OFF', { retain: true });
}
​
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}