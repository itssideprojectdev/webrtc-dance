import ElevenLabs from 'elevenlabs-node';
import {config} from 'dotenv';
import express from 'express';
import http from 'http';
import {RTCIceCandidate, nonstandard, MediaStream, RTCPeerConnection, RTCSessionDescription} from '@roamhq/wrtc';
import {Server} from 'socket.io';
import lamejs from 'lamejs';
import fs from 'fs';
import cors from 'cors';
import {RTCAudioData} from '@roamhq/wrtc/types/nonstandard';
import {OpenAI} from 'openai';
import {makeOpenaiRequest, makeOpenaiRequestRaw} from './openai';
import {z} from 'zod';
import {WaveFile} from 'wavefile';
import {NodeWebRtcAudioStreamSource} from './nodeWebrtcAudioStreamSource';
config();
const voice = new ElevenLabs({
  apiKey: process.env.ELEVENLABS_API_KEY,
  voiceId: 'pNInz6obpgDQGcFmaJgB', // A Voice ID from Elevenlabs
});

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
      const audioSource = new NodeWebRtcAudioStreamSource();
      const audioStreamTrack = audioSource.createTrack();
      const mediaStream = new MediaStream([audioStreamTrack]);
      peerConnection.addTrack(audioStreamTrack, mediaStream);

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
          console.log('processing audio');
          console.time('start');
          const mp3buf = mp3Encoder.flush();
          if (mp3buf.length > 0) {
            mp3Data.push(mp3buf);
          }
          const blob = new Blob(mp3Data, {type: 'audio/mp3'});
          const buffer = Buffer.from(await blob.arrayBuffer());
          fs.writeFileSync('audio_output.mp3', buffer);
          console.log('wrote audio');
          await timeout(5);
          const openai = new OpenAI(process.env.OPENAI_API_KEY);
          const transcription = await openai.audio.transcriptions.create({
            file: fs.createReadStream('audio_output.mp3'),
            model: 'whisper-1',
            language: 'en',
            response_format: 'text',
          });
          console.log('transcribed', transcription);

          const response = await makeOpenaiRequestRaw({
            model: 'gpt-4o',
            systemMessage: 'You respond to questions. Be helpful but terse.',
            userMessage: transcription,
            // zSchema: z.object({
            //   response: z.string(),
            // }),
            temperature: 0,
          });
          console.log('response', response);

          const tResponse = await voice.textToSpeech({
            // Required Parameters
            fileName: 'audio.wav', // The name of your audio file
            textInput: response, // The text you want to convert to speech

            // Optional Parameters
            voiceId: '21m00Tcm4TlvDq8ikWAM', // A different Voice ID from the default
            stability: 0.5, // The stability for the converted speech
            similarityBoost: 0.5, // The similarity boost for the converted speech
            modelId: 'eleven_multilingual_v2', // The ElevenLabs Model ID
            style: 1, // The style exaggeration for the converted speech
            speakerBoost: true, // The speaker boost for the converted speech
          });
          console.log('got response audio', tResponse);

          function streamAudioFile(filePath: string) {
            audioSource.addStream(fs.createReadStream(filePath), 16, 48000, 1);

            console.log('Streaming audio started');
          }

          console.log('sending audio');
          console.timeEnd('start');
          streamAudioFile('audio.wav');

          console.log('doneish');
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

function timeout(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
