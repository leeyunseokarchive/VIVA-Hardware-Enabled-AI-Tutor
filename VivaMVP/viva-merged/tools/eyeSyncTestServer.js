/**
 * Local stand-in for the VIVA display board's WebSocket server.
 *
 * Lets you verify the phone app is sending eye-state messages correctly
 * BEFORE the physical ESP32-S3 board arrives. Once the real board's
 * firmware exists, this script is no longer needed - it's purely a dev
 * tool to unblock the app-side work in the meantime.
 *
 * Usage:
 *   1. npm install --save-dev ws   (one-time; not added to app dependencies)
 *   2. node tools/eyeSyncTestServer.js
 *   3. In .env, set EXPO_PUBLIC_EYE_SYNC_WS_URL=ws://<this-machine's-LAN-IP>:8787
 *      (use your computer's IP, not localhost, if testing from a phone/simulator
 *      on the same network - localhost on the phone refers to the phone itself)
 *   4. Run the app and change screens/trigger state changes - you should see
 *      each eyeState print below as it arrives.
 */
const { WebSocketServer } = require('ws');

const PORT = 8787;
const wss = new WebSocketServer({ port: PORT });

console.log(`[eyeSyncTestServer] Listening on ws://0.0.0.0:${PORT}`);
console.log('[eyeSyncTestServer] Waiting for the app to connect...\n');

wss.on('connection', (socket, req) => {
  const remote = req.socket.remoteAddress;
  console.log(`[eyeSyncTestServer] App connected from ${remote}`);

  socket.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      const time = new Date(msg.ts ?? Date.now()).toLocaleTimeString();
      console.log(`[${time}] eyeState -> ${msg.eyeState}`);
    } catch (err) {
      console.warn('[eyeSyncTestServer] Received non-JSON message:', data.toString());
    }
  });

  socket.on('close', () => {
    console.log('[eyeSyncTestServer] App disconnected');
  });
});
