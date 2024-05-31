import {config} from 'dotenv';
import express from 'express';
import http from 'http';
import {RTCIceCandidate, nonstandard, MediaStream, RTCPeerConnection, RTCSessionDescription} from '@roamhq/wrtc';
import {Server} from 'socket.io';
import lamejs from 'lamejs';
import fs from 'fs';
import cors from 'cors';
import {RTCAudioData} from '@roamhq/wrtc/types/nonstandard';

config();

async function main() {
  const app = express();
  app.use(cors());
  const server = http.createServer(app);
  const io = new Server(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
    },
  });

  const peerConnections = {};

  io.on('connection', (socket) => {
    console.log('New client connected');

    socket.on('offer', async (description) => {
      const peerConnection = new RTCPeerConnection({
        iceServers: [
          {urls: 'stun:stun.l.google.com:19302'},
          // Add TURN servers here if needed
        ],
      });

      peerConnections[socket.id] = peerConnection;

      peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit('candidate', event.candidate);
        }
      };

      peerConnection.ontrack = (event) => {
        const audio = event.streams[0];
        const audioTracks = audio.getAudioTracks();
        const audioTrack = audioTracks[0];

        const sink = new nonstandard.RTCAudioSink(audioTrack);

        const mp3Encoder = new lamejs.Mp3Encoder(1, 48000, 128);
        const mp3Data = [];
        sink.ondata = (data) => {
          const samples = new Int16Array(data.samples.buffer);
          const mp3buf = mp3Encoder.encodeBuffer(samples);
          if (mp3buf.length > 0) {
            mp3Data.push(mp3buf);
          }
        };

        setTimeout(async () => {
          sink.stop();
          const mp3buf = mp3Encoder.flush();
          if (mp3buf.length > 0) {
            mp3Data.push(mp3buf);
          }
          const blob = new Blob(mp3Data, {type: 'audio/mp3'});
          const buffer = Buffer.from(await blob.arrayBuffer());
          fs.writeFileSync('audio_output.mp3', buffer);
          console.log('Recording saved to audio_output.mp3');
        }, 5000); // Stop recording after 5 seconds
      };

      const desc = new RTCSessionDescription(description);
      await peerConnection.setRemoteDescription(desc);

      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);

      socket.emit('answer', peerConnection.localDescription);
    });

    socket.on('candidate', async (candidate) => {
      const peerConnection = peerConnections[socket.id];
      if (peerConnection) {
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      }
    });

    socket.on('disconnect', () => {
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

function streamAudioFile(filePath, peerConnection) {
  const audioTrack = new nonstandard.RTCAudioSource().createTrack();
  const audioSource = new nonstandard.RTCAudioSource();
  const audioStreamTrack = audioSource.createTrack();
  const responseAudio = fs.createReadStream(filePath);

  audioSource.onData({
    samples: chunk,
    sampleRate: 48000,
    bitsPerSample: 16,
    channelCount: 2,
    numberOfFrames: chunk.length / 2,
  });

  const mediaStream = new MediaStream([audioStreamTrack]);
  peerConnection.addTrack(audioStreamTrack, mediaStream);
}

// streamAudioFile(`C:\\code\\webrtc-dance\\server\\otto.mp3`, peerConnection);
