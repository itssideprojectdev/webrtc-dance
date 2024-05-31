import {config} from 'dotenv';
import express from 'express';
import http from 'http';
import {RTCPeerConnection, RTCSessionDescription} from '@roamhq/wrtc';
import {Server} from 'socket.io';
import fs from 'fs';
import {exec} from 'child_process';

config();



async function main() {


  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);

  const peerConnections:{
    [id: string]: RTCPeerConnection;

  } = {};

  io.on('connection', socket => {
    console.log('New client connected');

    socket.on('offer', async (id, description) => {
      const peerConnection = new RTCPeerConnection();
      peerConnections[id] = peerConnection;

      const desc = new RTCSessionDescription(description);
      await peerConnection.setRemoteDescription(desc);

      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);

      socket.emit('answer', id, peerConnection.localDescription);

      peerConnection.ontrack = event => {
        // Handle audio track
        const audio = event.streams[0];
        const filePath = `/tmp/audio-${id}.webm`;
        const writeStream = fs.createWriteStream(filePath);

        audio.pipe(writeStream);

        writeStream.on('finish', () => {
          // Process audio file with Whisper and ElevenLabs
          exec(`whisper-cli ${filePath}`, (error, stdout, stderr) => {
            if (error) {
              console.error(`Error with Whisper: ${error.message}`);
              return;
            }
            const transcript = stdout.trim();

            // Process transcript and convert to speech using ElevenLabs
            exec(`elevenlabs-cli --text "${transcript}" --output /tmp/response-${id}.mp3`, (error, stdout, stderr) => {
              if (error) {
                console.error(`Error with ElevenLabs: ${error.message}`);
                return;
              }

              // Stream response back over WebRTC
              const responseAudio = fs.createReadStream(`/tmp/response-${id}.mp3`);
              peerConnection.addTrack(responseAudio, audio);
            });
          });
        });
      };
    });

    socket.on('disconnect', () => {
      console.log('Client disconnected');
      const peerConnection = peerConnections[socket.id];
      if (peerConnection) {
        peerConnection.close();
        delete peerConnections[socket.id];
      }
    });
  });

  server.listen(3000, () => console.log('Server is running on port 3000'));
}

main().then(() => {});
