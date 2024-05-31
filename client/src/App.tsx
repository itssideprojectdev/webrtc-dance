import React, {useState, useRef, useEffect} from 'react';
import io from 'socket.io-client';

function App() {
  const [isRecording, setIsRecording] = useState(false);
  const socketRef = useRef();
  const localStreamRef = useRef();
  const peerConnectionRef = useRef();
  const audioElementRef = useRef();

  const startRecording = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({audio: true});
    localStreamRef.current = stream;
    const peerConnection = new RTCPeerConnection({
      iceServers: [
        {urls: 'stun:stun.l.google.com:19302'},
        // Add TURN servers here if needed
      ],
    });
    peerConnectionRef.current = peerConnection;

    stream.getTracks().forEach((track) => peerConnection.addTrack(track, stream));

    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        socketRef.current.emit('candidate', event.candidate);
      }
    };

    peerConnection.ontrack = (event) => {
      console.log('on track');
      const [remoteStream] = event.streams;
      audioElementRef.current.srcObject = remoteStream;
    };

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    socketRef.current.emit('offer', peerConnection.localDescription);

    socketRef.current.on('answer', async (description) => {
      const desc = new RTCSessionDescription(description);
      await peerConnection.setRemoteDescription(desc);
    });

    socketRef.current.on('candidate', async (candidate) => {
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    });

    setIsRecording(true);
  };

  const stopRecording = () => {
    localStreamRef.current.getTracks().forEach((track) => track.stop());
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
    }
    setIsRecording(false);
  };

  useEffect(() => {
    const socket = io('http://localhost:3000');
    socketRef.current = socket;

    return () => {
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => track.stop());
      }
      if (socketRef.current) {
        socketRef.current.disconnect();
      }
      if (peerConnectionRef.current) {
        peerConnectionRef.current.close();
      }
    };
  }, []);

  return (
    <div>
      <h1>Audio Chat Bot</h1>
      <button onClick={isRecording ? stopRecording : startRecording}>
        {isRecording ? 'Stop Recording' : 'Start Recording'}
      </button>
      <audio ref={audioElementRef} autoPlay></audio>
    </div>
  );
}

export default App;
/*
const mediaRecorder = new MediaRecorder(stream, {
  mimeType: 'audio/webm',
});
const recordedChunks = [];

mediaRecorder.ondataavailable = (event) => {
  if (event.data.size > 0) {
    recordedChunks.push(event.data);
  }
};

mediaRecorder.onstop = () => {
  const blob = new Blob(recordedChunks, {type: 'audio/webm'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.style.display = 'none';
  a.href = url;
  a.download = 'audio_recording.webm';
  document.body.appendChild(a);
  a.click();
  URL.revokeObjectURL(url);
};
mediaRecorder.start();
setTimeout(() => {
  mediaRecorder.stop();
}, 2000);

return;*/
