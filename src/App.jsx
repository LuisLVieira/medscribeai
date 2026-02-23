import React, { useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

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
  const [isStartingRecording, setIsStartingRecording] = useState(false);
  const [statusText, setStatusText] = useState('Idle');
  const [errorText, setErrorText] = useState('');
  const [vadSensitivity, setVadSensitivity] = useState(2);

  const [setupVisible, setSetupVisible] = useState(true);
  const [setupStatus, setSetupStatus] = useState(null);
  const [setupLoading, setSetupLoading] = useState(true);
  const [setupError, setSetupError] = useState('');
  const [modelDownloads, setModelDownloads] = useState({});

  const currentPatientIdRef = useRef(currentPatientId);

  useEffect(() => {
    currentPatientIdRef.current = currentPatientId;
  }, [currentPatientId]);

  const refreshSetupStatus = async () => {
    if (!isTauri()) {
      setSetupStatus({ models_root: '', models: [], all_ready: true });
      setSetupLoading(false);
      return;
    }

    try {
      setSetupLoading(true);
      const status = await invoke('get_model_setup_status');
      setSetupStatus(status || { models_root: '', models: [], all_ready: false });
      setSetupError('');
    } catch (err) {
      setSetupError(String(err));
    } finally {
      setSetupLoading(false);
    }
  };

  useEffect(() => {
    refreshSetupStatus();
  }, []);

  useEffect(() => {
    if (!isTauri()) {
      return () => {};
    }

    let cancelled = false;
    const unlisteners = [];

    const setup = async () => {
      const unlistenUpdate = await listen('transcription-update', (event) => {
        const segment = event.payload || {};
        const text = (segment.text || '').trim();
        if (!text) {
          return;
        }

        const startMs = typeof segment.start_ms === 'number' ? segment.start_ms : null;
        const endMs = typeof segment.end_ms === 'number' ? segment.end_ms : null;
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
              last.text === text &&
              last.start_ms === startMs &&
              last.end_ms === endMs;
            if (isDuplicate) {
              return patient;
            }
            return {
              ...patient,
              transcript: patient.transcript ? `${patient.transcript}\n${text}` : text,
              segments: [
                ...prevSegments,
                {
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

      const unlistenProgress = await listen('model-download-progress', async (event) => {
        const payload = event.payload || {};
        const modelId = payload.model_id;
        if (!modelId) {
          return;
        }

        setModelDownloads((prev) => ({
          ...prev,
          [modelId]: payload
        }));

        if (payload.status === 'completed' || payload.progress >= 1) {
          await refreshSetupStatus();
        }
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
      setIsStartingRecording(true);
      setErrorText('');
      setStatusText('Starting microphone...');
      await invoke('start_transcription', {
        config: {
          vad_sensitivity: Number(vadSensitivity),
          max_chunk_seconds: 14
        }
      });
      setRecording(true);
      setStatusText('Listening...');
    } catch (err) {
      setErrorText(String(err));
      setStatusText('Failed to start');
    } finally {
      setIsStartingRecording(false);
    }
  };

  const stopRecording = async () => {
    if (!isTauri()) {
      setRecording(false);
      return;
    }

    const targetPatientId = currentPatientIdRef.current;
    const transcriptForSoap =
      patients.find((patient) => patient.id === targetPatientId)?.transcript?.trim() || '';

    try {
      await invoke('stop_transcription');
    } catch (_err) {
      // no-op
    }

    setRecording(false);
    if (!transcriptForSoap) {
      setStatusText('Idle');
      return;
    }

    try {
      setStatusText('Generating SOAP note...');
      const soapText = await invoke('generate_soap_note', {
        transcript: transcriptForSoap
      });
      setPatients((prev) =>
        prev.map((patient) =>
          patient.id === targetPatientId
            ? {
                ...patient,
                soap: formatSoapTextAsHtml(String(soapText || ''))
              }
            : patient
        )
      );
      setStatusText('Idle');
    } catch (err) {
      setErrorText(String(err));
      setStatusText('SOAP note generation failed');
    }
  };

  const downloadModel = async (modelId) => {
    if (!isTauri()) {
      return;
    }

    setSetupError('');
    setModelDownloads((prev) => ({
      ...prev,
      [modelId]: {
        model_id: modelId,
        progress: 0,
        downloaded_bytes: 0,
        total_bytes: null,
        status: 'downloading'
      }
    }));

    try {
      await invoke('download_required_model', { modelId });
      await refreshSetupStatus();
    } catch (err) {
      setSetupError(String(err));
      setModelDownloads((prev) => ({
        ...prev,
        [modelId]: {
          ...(prev[modelId] || { model_id: modelId }),
          status: 'error'
        }
      }));
    }
  };

  const currentPatient = patients.find((p) => p.id === currentPatientId);
  const toggleRecording = () => {
    if (isStartingRecording) {
      return;
    }
    if (recording) {
      stopRecording();
      return;
    }
    startRecording();
  };

  if (setupVisible) {
    return (
      <StartupSetupScreen
        setupStatus={setupStatus}
        setupLoading={setupLoading}
        setupError={setupError}
        modelDownloads={modelDownloads}
        onDownloadModel={downloadModel}
        onStartUsing={() => setSetupVisible(false)}
      />
    );
  }

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
            recording={recording}
            isStartingRecording={isStartingRecording}
            onToggleRecording={toggleRecording}
            vadSensitivity={vadSensitivity}
            setVadSensitivity={setVadSensitivity}
            statusText={statusText}
            errorText={errorText}
          />
        )}
      </main>
    </div>
  );
}

function StartupSetupScreen({
  setupStatus,
  setupLoading,
  setupError,
  modelDownloads,
  onDownloadModel,
  onStartUsing
}) {
  const models = setupStatus?.models || [];
  const canStart = !!setupStatus?.all_ready;

  return (
    <div className="setup-screen-root">
      <div className="setup-card-shell">
        <h1 className="setup-title">Model Setup</h1>
        <p className="setup-subtitle">
          Download the required local models before using MedScribeAI.
        </p>

        {setupStatus?.models_root && (
          <p className="setup-root-path">Storage location: {setupStatus.models_root}</p>
        )}

        {setupLoading && <p className="setup-loading">Checking model status...</p>}

        {!setupLoading && (
          <div className="setup-model-list">
            {models.map((model) => {
              const progress = modelDownloads[model.model_id] || null;
              const isDownloading = progress?.status === 'downloading';
              const percent =
                progress && typeof progress.progress === 'number'
                  ? Math.round(progress.progress * 100)
                  : 0;

              return (
                <section className="setup-model-card" key={model.model_id}>
                  <div className="setup-model-top">
                    <div>
                      <h2 className="setup-model-name">{model.label}</h2>
                      <p className={`setup-model-badge ${model.ready ? 'ready' : 'missing'}`}>
                        {model.ready ? 'Ready' : 'Not downloaded'}
                      </p>
                    </div>
                    <button
                      className="setup-download-btn"
                      disabled={model.ready || isDownloading}
                      onClick={() => onDownloadModel(model.model_id)}
                    >
                      {model.ready ? 'Downloaded' : isDownloading ? 'Downloading...' : 'Download'}
                    </button>
                  </div>

                  {isDownloading && (
                    <div className="setup-progress-wrap">
                      <div className="setup-progress-track">
                        <div className="setup-progress-fill" style={{ width: `${percent}%` }} />
                      </div>
                      <span className="setup-progress-label">{percent}%</span>
                    </div>
                  )}

                  {model.path && <p className="setup-model-path">{model.path}</p>}
                </section>
              );
            })}
          </div>
        )}

        {setupError && <p className="setup-error">{setupError}</p>}

        <button className="setup-start-btn" disabled={!canStart} onClick={onStartUsing}>
          Start using
        </button>
      </div>
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

function MainContent({
  patient,
  onUpdatePatient,
  recording,
  isStartingRecording,
  onToggleRecording,
  vadSensitivity,
  setVadSensitivity,
  statusText,
  errorText
}) {
  const streamLines = getTranscriptStreamLines(patient);

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
          {errorText && <span className="ml-4 text-red-600">{errorText}</span>}
        </div>
      </header>

      <div className="px-6 py-3 border-b border-gray-200">
        <TopTranscriptStreamBar
          streamLines={streamLines}
          recording={recording}
          isStartingRecording={isStartingRecording}
          onToggleRecording={onToggleRecording}
          vadSensitivity={vadSensitivity}
          setVadSensitivity={setVadSensitivity}
          statusText={statusText}
        />
      </div>

      <div className="flex-1 flex flex-col min-h-0">
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
  );
}

function getTranscriptStreamLines(patient) {
  const segments = patient.segments || [];
  if (segments.length > 0) {
    return segments.slice(-6).map((segment) => segment.text);
  }

  if (patient.transcript) {
    return patient.transcript
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-4);
  }

  return [];
}

function TopTranscriptStreamBar({
  streamLines,
  recording,
  isStartingRecording,
  onToggleRecording,
  vadSensitivity,
  setVadSensitivity,
  statusText
}) {
  const isActive = recording || isStartingRecording;
  const lines = isActive
    ? streamLines.length > 0
      ? streamLines
      : ['Waiting for speech...']
    : ['Press record to start listening'];

  return (
    <section
      className={`transcript-stream-bar ${isActive ? 'transcript-stream-bar-active' : ''}`}
      role="status"
      aria-live="polite"
      aria-label="Live transcript listening feedback"
    >
      {isActive && <div className="transcript-stream-label">Listening</div>}
      <div className="transcript-stream-viewport">
        <div className={`transcript-stream-track ${isActive ? 'transcript-stream-track-active' : ''}`}>
          {[...lines, ...lines].map((line, idx) => (
            <div className="transcript-stream-line" key={`${line}-${idx}`}>
              {line}
            </div>
          ))}
        </div>
      </div>
      <div className="transcript-controls">
        <div className="transcript-controls-selects">
          <label htmlFor="top-vad-select" className="text-xs">VAD</label>
          <select
            id="top-vad-select"
            value={vadSensitivity}
            onChange={(e) => setVadSensitivity(Number(e.target.value))}
            className="top-stream-select"
          >
            <option value={0}>0</option>
            <option value={1}>1</option>
            <option value={2}>2</option>
            <option value={3}>3</option>
          </select>
        </div>
        <button
          onClick={onToggleRecording}
          disabled={isStartingRecording}
          className={`top-record-btn ${recording ? 'top-record-btn-stop' : 'top-record-btn-start'}`}
          aria-label={recording ? 'Stop recording' : 'Start recording'}
        >
          {recording ? <StopIcon /> : <MicrophoneIcon />}
        </button>
      </div>
      {isActive && <div className="transcript-stream-status">{statusText}</div>}
    </section>
  );
}

function formatSoapTextAsHtml(text) {
  const lines = text.split('\n');
  const htmlParts = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const section = line.match(/^(Subjective|Objective|Assessment|Plan)\s*:?\s*$/i);
    if (section) {
      const title = section[1].charAt(0).toUpperCase() + section[1].slice(1).toLowerCase();
      htmlParts.push(`<h3>${escapeHtml(title)}</h3>`);
      continue;
    }

    htmlParts.push(`<p>${escapeHtml(line)}</p>`);
  }

  if (htmlParts.length === 0) {
    return `<p>${escapeHtml(text.trim())}</p>`;
  }

  return htmlParts.join('\n');
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
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
