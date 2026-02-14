import React, { useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

function formatClockFromMs(ms) {
  if (typeof ms !== 'number') {
    const now = new Date();
    return now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
  const ss = String(seconds % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function appendTranscriptionLine(speaker, text, startMs, endMs) {
  const speakerName = speaker || 'Unknown';
  const startLabel = formatClockFromMs(startMs);
  const endLabel = typeof endMs === 'number' ? formatClockFromMs(endMs) : null;
  const stamp = endLabel ? `${startLabel}-${endLabel}` : startLabel;
  return `[${stamp}] ${speakerName}: ${text}`;
}

export default function App() {
  const [patients, setPatients] = useState([
    {
      id: '1',
      name: 'John Smith',
      transcript: `[10:32 AM] Patient: I've been having headaches for the past two weeks.\n\n[10:32 AM] Doctor: Can you describe the headaches? Where exactly do you feel them?`,
      segments: [],
      soap: `<h3>Subjective</h3>\n<p>Patient reports recurring headaches for 2 weeks, primarily right-sided, throbbing in nature. Occurs daily, mostly afternoon. Associated nausea occasionally. No visual disturbances.</p>\n\n<h3>Objective</h3>\n<p>Vitals stable. Neurological exam normal. No focal deficits.</p>\n\n<h3>Assessment</h3>\n<p>Migraine headaches, probable.</p>\n\n<h3>Plan</h3>\n<p>1. Start sumatriptan 50mg as needed\n2. Keep headache diary\n3. Follow up in 2 weeks\n4. MRI if symptoms worsen</p>`
    },
    {
      id: '2',
      name: 'Sarah Johnson',
      transcript: `[2:15 PM] Patient: I think I sprained my ankle playing basketball yesterday.\n\n[2:15 PM] Doctor: Let me take a look. Can you walk on it?`,
      segments: [],
      soap: `<h3>Subjective</h3>\n<p>Ankle injury during basketball 24 hours ago. Moderate pain with ambulation.</p>\n\n<h3>Objective</h3>\n<p>Edema present lateral ankle. Ecchymosis noted. Tender to palpation. ROM limited by pain.</p>\n\n<h3>Assessment</h3>\n<p>Lateral ankle sprain, grade 2.</p>\n\n<h3>Plan</h3>\n<p>RICE protocol, NSAIDs, ankle brace, follow up 1 week.</p>`
    }
  ]);

  const [currentPatientId, setCurrentPatientId] = useState('1');
  const [recording, setRecording] = useState(false);
  const [statusText, setStatusText] = useState('Idle');
  const [errorText, setErrorText] = useState('');
  const [downloadProgress, setDownloadProgress] = useState(null);
  const [modelChoice, setModelChoice] = useState('tiny.en');
  const [vadSensitivity, setVadSensitivity] = useState(2);
  const [autoSpeakerLabeling, setAutoSpeakerLabeling] = useState(true);

  const currentPatientIdRef = useRef(currentPatientId);

  useEffect(() => {
    currentPatientIdRef.current = currentPatientId;
  }, [currentPatientId]);

  useEffect(() => {
    if (!isTauri()) {
      return () => {};
    }

    let cancelled = false;
    const unlisteners = [];

    const setup = async () => {
      const unlistenUpdate = await listen('transcription-update', (event) => {
        const segment = event.payload || {};
        const speaker = segment.speaker || 'Unknown';
        const text = (segment.text || '').trim();
        if (!text) {
          return;
        }

        const startMs = typeof segment.start_ms === 'number' ? segment.start_ms : null;
        const endMs = typeof segment.end_ms === 'number' ? segment.end_ms : null;
        const line = appendTranscriptionLine(speaker, text, startMs, endMs);
        const targetPatientId = currentPatientIdRef.current;

        setPatients((prev) =>
          prev.map((patient) => {
            if (patient.id !== targetPatientId) {
              return patient;
            }
            const prevSegments = patient.segments || [];
            const last = prevSegments[prevSegments.length - 1];
            const isDuplicate =
              !!last &&
              last.speaker === speaker &&
              last.text === text &&
              last.start_ms === startMs &&
              last.end_ms === endMs;
            if (isDuplicate) {
              return patient;
            }
            return {
              ...patient,
              transcript: patient.transcript ? `${patient.transcript}\n${line}` : line,
              segments: [
                ...prevSegments,
                {
                  speaker,
                  text,
                  start_ms: startMs,
                  end_ms: endMs
                }
              ]
            };
          })
        );
      });
      if (cancelled) {
        unlistenUpdate();
      } else {
        unlisteners.push(unlistenUpdate);
      }

      const unlistenError = await listen('transcription-error', (event) => {
        const message = event.payload?.message || 'Unknown transcription error';
        setErrorText(message);
        setStatusText('Error');
        setRecording(false);
      });
      if (cancelled) {
        unlistenError();
      } else {
        unlisteners.push(unlistenError);
      }

      const unlistenProgress = await listen('model-download-progress', (event) => {
        const payload = event.payload || {};
        setDownloadProgress(payload);
        setStatusText(`Downloading ${payload.model || 'model'}...`);
      });
      if (cancelled) {
        unlistenProgress();
      } else {
        unlisteners.push(unlistenProgress);
      }
    };

    setup();

    return () => {
      cancelled = true;
      for (const unlistenFn of unlisteners) {
        unlistenFn();
      }
    };
  }, []);

  useEffect(() => {
    return () => {
      if (isTauri()) {
        invoke('stop_transcription').catch(() => {});
      }
    };
  }, []);

  const addPatient = () => {
    const newId = Date.now().toString();
    const newPatient = {
      id: newId,
      name: 'New Patient',
      transcript: '',
      segments: [],
      soap: `<h3>Subjective</h3>\n<p>Enter patient symptoms and history...</p>\n\n<h3>Objective</h3>\n<p>Enter physical exam findings...</p>\n\n<h3>Assessment</h3>\n<p>Enter diagnosis...</p>\n\n<h3>Plan</h3>\n<p>Enter treatment plan...</p>`
    };
    setPatients((prev) => [...prev, newPatient]);
    setCurrentPatientId(newId);
  };

  const updatePatient = (id, field, value) => {
    setPatients((prev) => prev.map((p) => (p.id === id ? { ...p, [field]: value } : p)));
  };

  const startRecording = async () => {
    if (!isTauri()) {
      setErrorText('Tauri API not available. Start with `npm run tauri dev` (not `npm run dev`).');
      return;
    }

    try {
      setErrorText('');
      setStatusText('Starting microphone...');
      setDownloadProgress(null);
      await invoke('start_transcription', {
        config: {
          model: modelChoice,
          vad_sensitivity: Number(vadSensitivity),
          max_chunk_seconds: 14,
          auto_speaker_labeling: autoSpeakerLabeling
        }
      });
      setRecording(true);
      setStatusText('Listening...');
    } catch (err) {
      setErrorText(String(err));
      setStatusText('Failed to start');
    }
  };

  const stopRecording = async () => {
    if (!isTauri()) {
      setRecording(false);
      return;
    }

    try {
      await invoke('stop_transcription');
    } catch (_err) {
      // no-op
    }
    setRecording(false);
    setStatusText('Idle');
  };

  const currentPatient = patients.find((p) => p.id === currentPatientId);

  return (
    <div className="flex h-screen bg-white text-gray-900 font-sans">
      <Sidebar
        patients={patients}
        currentPatientId={currentPatientId}
        onSelectPatient={setCurrentPatientId}
        onAddPatient={addPatient}
      />

      <main className="flex-1 flex flex-col min-h-screen">
        {currentPatient && (
          <MainContent
            patient={currentPatient}
            onUpdatePatient={updatePatient}
            statusText={statusText}
            errorText={errorText}
            downloadProgress={downloadProgress}
          />
        )}
      </main>

      {!recording && (
        <button
          onClick={startRecording}
          className="fixed bottom-8 left-1/2 transform -translate-x-1/2 w-16 h-16 bg-red-500 hover:bg-red-600 text-white rounded-full shadow-lg flex items-center justify-center z-20 transition-colors"
          aria-label="Start recording"
        >
          <MicrophoneIcon />
        </button>
      )}

      {recording && (
        <RecordingBar
          onClose={stopRecording}
          modelChoice={modelChoice}
          setModelChoice={setModelChoice}
          vadSensitivity={vadSensitivity}
          setVadSensitivity={setVadSensitivity}
          autoSpeakerLabeling={autoSpeakerLabeling}
          setAutoSpeakerLabeling={setAutoSpeakerLabeling}
          statusText={statusText}
        />
      )}
    </div>
  );
}

function Sidebar({ patients, currentPatientId, onSelectPatient, onAddPatient }) {
  return (
    <aside className="w-72 bg-gray-50 border-r border-gray-200 flex flex-col h-screen">
      <div className="p-4 border-b border-gray-200">
        <h2 className="text-lg font-semibold text-gray-800">Patients</h2>
      </div>

      <nav className="flex-1 overflow-y-auto py-2">
        {patients.map((patient) => (
          <button
            key={patient.id}
            onClick={() => onSelectPatient(patient.id)}
            className={`w-full text-left px-4 py-3 transition-colors relative ${
              currentPatientId === patient.id
                ? 'bg-blue-50 text-blue-700 border-l-4 border-blue-500'
                : 'hover:bg-gray-100 border-l-4 border-transparent'
            }`}
            aria-label={`Select patient ${patient.name}`}
          >
            <div className="font-medium truncate">{patient.name}</div>
            <div className="text-xs text-gray-500 mt-1">
              {patient.transcript ? 'Has transcript' : 'No transcript'}
            </div>
          </button>
        ))}
      </nav>

      <div className="p-4 border-t border-gray-200">
        <button
          onClick={onAddPatient}
          className="w-12 h-12 bg-blue-500 hover:bg-blue-600 text-white rounded-full flex items-center justify-center mx-auto transition-colors shadow-md"
          aria-label="Add new patient"
        >
          <PlusIcon />
        </button>
      </div>
    </aside>
  );
}

function MainContent({ patient, onUpdatePatient, statusText, errorText, downloadProgress }) {
  return (
    <div className="flex-1 flex flex-col">
      <header className="px-8 py-6 border-b border-gray-200">
        <input
          type="text"
          value={patient.name}
          onChange={(e) => onUpdatePatient(patient.id, 'name', e.target.value)}
          className="text-3xl font-semibold text-gray-900 border-none outline-none w-full bg-transparent focus:ring-0"
          placeholder="Patient Name"
          aria-label="Patient name"
        />
        <div className="mt-3 text-sm">
          <span className="font-medium text-gray-700">Status:</span>{' '}
          <span className="text-gray-600">{statusText}</span>
          {downloadProgress && typeof downloadProgress.progress === 'number' && (
            <span className="ml-3 text-gray-500">
              {Math.round(downloadProgress.progress * 100)}%
            </span>
          )}
          {errorText && <span className="ml-4 text-red-600">{errorText}</span>}
        </div>
      </header>

      <div className="flex-1 flex divide-x divide-gray-200">
        <div className="flex-1 flex flex-col">
          <div className="px-6 py-4 border-b border-gray-200">
            <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">
              Conversation Transcript
            </h3>
          </div>
          <div className="flex-1 overflow-y-auto p-6">
            {patient.segments && patient.segments.length > 0 ? (
              <div className="space-y-3">
                {patient.segments.map((segment, idx) => (
                  <div
                    key={`${segment.start_ms || idx}-${idx}`}
                    className={`transcription-line ${speakerClassName(segment.speaker)}`}
                  >
                    <div className="transcription-meta">
                      <span className="font-semibold">{segment.speaker || 'Unknown'}</span>
                      <span className="ml-2 text-xs opacity-70">
                        {formatClockFromMs(segment.start_ms)}
                      </span>
                    </div>
                    <div>{segment.text}</div>
                  </div>
                ))}
              </div>
            ) : patient.transcript ? (
              <div className="whitespace-pre-wrap text-gray-700 leading-relaxed">
                {patient.transcript}
              </div>
            ) : (
              <p className="text-gray-400 italic">
                No transcript yet. Start recording to capture the conversation.
              </p>
            )}
          </div>
        </div>

        <div className="flex-1 flex flex-col">
          <div className="px-6 py-4 border-b border-gray-200">
            <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">SOAP Note</h3>
          </div>
          <div className="flex-1 overflow-y-auto p-6">
            <div
              contentEditable
              suppressContentEditableWarning
              onBlur={(e) => onUpdatePatient(patient.id, 'soap', e.currentTarget.innerHTML)}
              className="prose prose-sm max-w-none outline-none focus:ring-2 focus:ring-blue-200 rounded p-2 min-h-full"
              dangerouslySetInnerHTML={{ __html: patient.soap }}
              aria-label="SOAP note editor"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function speakerClassName(speaker) {
  if (speaker === 'Doctor') {
    return 'transcription-speaker-doctor';
  }
  if (speaker === 'Patient') {
    return 'transcription-speaker-patient';
  }
  return 'transcription-speaker-unknown';
}

function RecordingBar({
  onClose,
  modelChoice,
  setModelChoice,
  vadSensitivity,
  setVadSensitivity,
  autoSpeakerLabeling,
  setAutoSpeakerLabeling,
  statusText
}) {
  return (
    <div className="fixed bottom-0 left-0 right-0 bg-gray-800 text-white shadow-2xl z-30 animate-slide-up">
      <div className="flex flex-wrap items-center justify-between px-6 py-4 gap-4 min-h-20">
        <div className="flex items-center gap-2">
          <div className="text-sm font-medium mr-2">Recording</div>
          <AudioVisualizer />
          <div className="text-xs text-gray-300 ml-2">{statusText}</div>
        </div>

        <div className="flex items-center gap-3">
          <label htmlFor="model-select" className="text-xs">Model</label>
          <select
            id="model-select"
            value={modelChoice}
            onChange={(e) => setModelChoice(e.target.value)}
            className="bg-gray-700 text-white px-3 py-2 rounded border border-gray-600 outline-none focus:border-blue-500 text-sm"
          >
            <option value="tiny.en">tiny.en</option>
            <option value="base.en">base.en</option>
          </select>

          <label htmlFor="vad-select" className="text-xs">VAD</label>
          <select
            id="vad-select"
            value={vadSensitivity}
            onChange={(e) => setVadSensitivity(Number(e.target.value))}
            className="bg-gray-700 text-white px-3 py-2 rounded border border-gray-600 outline-none focus:border-blue-500 text-sm"
          >
            <option value={0}>0 (low)</option>
            <option value={1}>1</option>
            <option value={2}>2</option>
            <option value={3}>3 (high)</option>
          </select>

          <label className="text-xs flex items-center gap-2">
            <input
              type="checkbox"
              checked={autoSpeakerLabeling}
              onChange={(e) => setAutoSpeakerLabeling(e.target.checked)}
            />
            Auto label
          </label>
        </div>

        <div className="flex items-center gap-4">
          <button
            onClick={onClose}
            className="w-10 h-10 bg-red-600 hover:bg-red-700 rounded-full flex items-center justify-center transition-colors"
            aria-label="Stop recording"
          >
            <StopIcon />
          </button>
          <button
            onClick={onClose}
            className="w-8 h-8 hover:bg-gray-700 rounded flex items-center justify-center transition-colors"
            aria-label="Close recording bar"
          >
            <XIcon />
          </button>
        </div>
      </div>
    </div>
  );
}

function AudioVisualizer() {
  return (
    <div className="flex items-end gap-1 h-8">
      {[...Array(10)].map((_, i) => (
        <div
          key={i}
          className="w-1 bg-green-400 rounded-full animate-pulse"
          style={{
            height: `${20 + Math.random() * 80}%`,
            animationDelay: `${i * 0.1}s`,
            animationDuration: `${0.5 + Math.random() * 0.5}s`
          }}
        />
      ))}
    </div>
  );
}

function MicrophoneIcon() {
  return (
    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
      <rect x="6" y="6" width="12" height="12" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}
