import React, { useEffect, useMemo, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

const DEFAULT_SOAP_TEMPLATE =
  '';
const MIC_SELECTION_STORAGE_KEY = 'medscribe.selectedMicDeviceKey';
const DEBUG_MODE_STORAGE_KEY = 'medscribe.debugModeEnabled';

export default function App() {
  const [patients, setPatients] = useState([]);
  const [currentPatientId, setCurrentPatientId] = useState(null);
  const [patientsLoaded, setPatientsLoaded] = useState(false);
  const [recording, setRecording] = useState(false);
  const [isStartingRecording, setIsStartingRecording] = useState(false);
  const [isGeneratingSoap, setIsGeneratingSoap] = useState(false);
  const [copyMessage, setCopyMessage] = useState('');
  const [statusText, setStatusText] = useState('Idle');
  const [errorText, setErrorText] = useState('');
  const [debugModeEnabled, setDebugModeEnabled] = useState(() => {
    if (typeof window === 'undefined') {
      return false;
    }
    return window.localStorage.getItem(DEBUG_MODE_STORAGE_KEY) === 'true';
  });
  const [debugErrors, setDebugErrors] = useState([]);
  const [vadSensitivity, setVadSensitivity] = useState(2);

  const [setupVisible, setSetupVisible] = useState(true);
  const [setupStatus, setSetupStatus] = useState(null);
  const [setupLoading, setSetupLoading] = useState(true);
  const [setupError, setSetupError] = useState('');
  const [modelDownloads, setModelDownloads] = useState({});
  const [modelDeleting, setModelDeleting] = useState({});
  const [micDevices, setMicDevices] = useState([]);
  const [micDevicesLoading, setMicDevicesLoading] = useState(true);
  const [micDevicesError, setMicDevicesError] = useState('');
  const [selectedMicDeviceKey, setSelectedMicDeviceKey] = useState('');
  const [micTestRunning, setMicTestRunning] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [micDetectedOnce, setMicDetectedOnce] = useState(false);

  const currentPatientIdRef = useRef(currentPatientId);
  const lastSavedPatientsJsonRef = useRef('');

  const reportError = (source, err) => {
    const message = String(err || '');
    if (!message.trim()) {
      return;
    }
    setErrorText(message);
    setDebugErrors((prev) => {
      const next = [
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          source,
          message,
          at: new Date().toISOString()
        },
        ...prev
      ];
      return next.slice(0, 60);
    });
  };

  useEffect(() => {
    currentPatientIdRef.current = currentPatientId;
  }, [currentPatientId]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    window.localStorage.setItem(DEBUG_MODE_STORAGE_KEY, debugModeEnabled ? 'true' : 'false');
  }, [debugModeEnabled]);

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
      reportError('setup-status', err);
    } finally {
      setSetupLoading(false);
    }
  };

  useEffect(() => {
    refreshSetupStatus();
  }, []);

  const refreshMicDevices = async () => {
    if (!isTauri()) {
      const fallback = [{ key: 'default', name: 'Default input', is_default: true }];
      setMicDevices(fallback);
      setSelectedMicDeviceKey('default');
      setMicDevicesError('');
      setMicDevicesLoading(false);
      return;
    }

    try {
      setMicDevicesLoading(true);
      const payload = await invoke('list_input_devices');
      const devices = Array.isArray(payload?.devices) ? payload.devices : [];
      const defaultDeviceKey =
        typeof payload?.default_device_key === 'string' ? payload.default_device_key : '';
      setMicDevices(devices);

      setSelectedMicDeviceKey((current) => {
        const availableKeys = new Set(
          devices.map((device) => (typeof device?.key === 'string' ? device.key : '')).filter(Boolean)
        );
        const persisted =
          typeof window !== 'undefined' ? window.localStorage.getItem(MIC_SELECTION_STORAGE_KEY) : '';
        const next =
          (current && availableKeys.has(current) && current) ||
          (persisted && availableKeys.has(persisted) && persisted) ||
          (defaultDeviceKey && availableKeys.has(defaultDeviceKey) && defaultDeviceKey) ||
          (devices[0]?.key || '');

        if (typeof window !== 'undefined') {
          if (next) {
            window.localStorage.setItem(MIC_SELECTION_STORAGE_KEY, next);
          } else {
            window.localStorage.removeItem(MIC_SELECTION_STORAGE_KEY);
          }
        }
        return next;
      });

      setMicDevicesError('');
    } catch (err) {
      setMicDevicesError(String(err));
      reportError('mic-devices', err);
    } finally {
      setMicDevicesLoading(false);
    }
  };

  const startMicTest = async () => {
    if (!isTauri()) {
      return;
    }

    try {
      setMicDevicesError('');
      setMicLevel(0);
      await invoke('start_mic_test', {
        deviceKey: selectedMicDeviceKey || null
      });
      setMicTestRunning(true);
    } catch (err) {
      setMicDevicesError(String(err));
      reportError('mic-test-start', err);
      setMicTestRunning(false);
    }
  };

  const stopMicTest = async () => {
    if (!isTauri()) {
      return;
    }
    try {
      await invoke('stop_mic_test');
    } catch (_err) {
      // no-op
    } finally {
      setMicTestRunning(false);
      setMicLevel(0);
    }
  };

  useEffect(() => {
    refreshMicDevices();
  }, []);

  useEffect(() => {
    const loadPatients = async () => {
      if (!isTauri()) {
        setPatientsLoaded(true);
        return;
      }

      try {
        const loaded = await invoke('load_patients');
        const normalized = (Array.isArray(loaded) ? loaded : []).map((p) => ({
          id: String(p.id),
          name: String(p.name || 'New Patient'),
          soap: String(p.soap || DEFAULT_SOAP_TEMPLATE),
          transcript: '',
          segments: []
        }));

        setPatients(normalized);
        const firstId = normalized[0]?.id || null;
        setCurrentPatientId(firstId);

        const serialized = JSON.stringify(
          normalized.map((p) => ({ id: p.id, name: p.name, soap: p.soap }))
        );
        lastSavedPatientsJsonRef.current = serialized;
      } catch (err) {
        reportError('load-patients', err);
      } finally {
        setPatientsLoaded(true);
      }
    };

    loadPatients();
  }, []);

  const persistedPatients = useMemo(
    () => patients.map((p) => ({ id: p.id, name: p.name, soap: p.soap })),
    [patients]
  );

  const persistedPatientsJson = useMemo(() => JSON.stringify(persistedPatients), [persistedPatients]);

  useEffect(() => {
    if (!patientsLoaded || !isTauri()) {
      return;
    }

    if (persistedPatientsJson === lastSavedPatientsJsonRef.current) {
      return;
    }

    const timer = setTimeout(async () => {
      try {
        await invoke('save_patients', { patients: persistedPatients });
        lastSavedPatientsJsonRef.current = persistedPatientsJson;
      } catch (err) {
        reportError('save-patients', err);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [patientsLoaded, persistedPatients, persistedPatientsJson]);

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
        reportError('transcription', message);
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

      const unlistenMicLevel = await listen('mic-test-level', (event) => {
        const payload = event.payload || {};
        const rms = Number(payload.rms || 0);
        const active = Boolean(payload.active);
        const normalized = Math.min(1, Math.max(0, rms * 12));
        setMicLevel((prev) => prev * 0.35 + normalized * 0.65);
        if (active) {
          setMicDetectedOnce(true);
        }
      });
      if (cancelled) {
        unlistenMicLevel();
      } else {
        unlisteners.push(unlistenMicLevel);
      }

      const unlistenMicError = await listen('mic-test-error', (event) => {
        const message = event.payload?.message || 'Microphone test failed';
        setMicDevicesError(message);
        reportError('mic-test', message);
        setMicTestRunning(false);
      });
      if (cancelled) {
        unlistenMicError();
      } else {
        unlisteners.push(unlistenMicError);
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
        invoke('stop_mic_test').catch(() => {});
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
      soap: DEFAULT_SOAP_TEMPLATE
    };
    setPatients((prev) => [...prev, newPatient]);
    setCurrentPatientId(newId);
  };

  const deletePatient = (patientId) => {
    const patient = patients.find((p) => p.id === patientId);
    if (!patient) {
      return;
    }

    setPatients((prev) => {
      const remaining = prev.filter((p) => p.id !== patientId);
      setCurrentPatientId((prevId) => {
        if (prevId !== patientId) {
          return prevId;
        }
        return remaining[0]?.id || null;
      });
      return remaining;
    });
  };

  const updatePatient = (id, field, value) => {
    setPatients((prev) => prev.map((p) => (p.id === id ? { ...p, [field]: value } : p)));
  };

  const startRecording = async () => {
    if (!isTauri()) {
      reportError(
        'recording-start',
        'Tauri API not available. Start with `npm run tauri dev` (not `npm run dev`).'
      );
      return;
    }

    try {
      if (micTestRunning) {
        await stopMicTest();
      }
      setIsStartingRecording(true);
      setErrorText('');
      setStatusText('Starting microphone...');
      await invoke('start_transcription', {
        config: {
          vad_sensitivity: Number(vadSensitivity),
          max_chunk_seconds: 14,
          input_device_key: selectedMicDeviceKey || null
        }
      });
      setRecording(true);
      setStatusText('Listening...');
    } catch (err) {
      reportError('recording-start', err);
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
      setIsGeneratingSoap(true);
      const soapText = await invoke('generate_soap_note', {
        transcript: transcriptForSoap
      });
      setPatients((prev) =>
        prev.map((patient) =>
          patient.id === targetPatientId
            ? {
                ...patient,
                soap: appendSoapHtml(patient.soap, formatSoapTextAsHtml(String(soapText || '')))
              }
            : patient
        )
      );
      setStatusText('Idle');
    } catch (err) {
      reportError('soap-generate', err);
      setStatusText('SOAP note generation failed');
    } finally {
      setIsGeneratingSoap(false);
    }
  };

  const copySoapToClipboard = async (patient) => {
    const patientName = (patient?.name || '').trim();
    const soapText = htmlToPlainText(String(patient?.soap || '')).trim();
    const body = patientName ? `${patientName}\n\n${soapText}` : soapText;
    if (!body) {
      return;
    }

    try {
      await navigator.clipboard.writeText(body);
      setCopyMessage('Copied');
      setTimeout(() => setCopyMessage(''), 1600);
    } catch (err) {
      reportError('copy-soap', `Failed to copy SOAP note: ${String(err)}`);
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
      reportError('model-download', err);
      setModelDownloads((prev) => ({
        ...prev,
        [modelId]: {
          ...(prev[modelId] || { model_id: modelId }),
          status: 'error'
        }
      }));
    }
  };

  const deleteModel = async (modelId) => {
    if (!isTauri()) {
      return;
    }

    setSetupError('');
    setModelDeleting((prev) => ({ ...prev, [modelId]: true }));

    try {
      await invoke('delete_required_model', { modelId });
      await refreshSetupStatus();
      setModelDownloads((prev) => {
        const next = { ...prev };
        delete next[modelId];
        return next;
      });
    } catch (err) {
      setSetupError(String(err));
      reportError('model-delete', err);
    } finally {
      setModelDeleting((prev) => ({ ...prev, [modelId]: false }));
    }
  };

  const currentPatient = patients.find((p) => p.id === currentPatientId) || null;
  const toggleRecording = () => {
    if (isStartingRecording || !currentPatient) {
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
      <>
      <StartupSetupScreen
        setupStatus={setupStatus}
        setupLoading={setupLoading}
        setupError={setupError}
        modelDownloads={modelDownloads}
        modelDeleting={modelDeleting}
        onDownloadModel={downloadModel}
        onDeleteModel={deleteModel}
        onStartUsing={async () => {
          await stopMicTest();
          setSetupVisible(false);
        }}
        vadSensitivity={vadSensitivity}
        setVadSensitivity={setVadSensitivity}
        micDevices={micDevices}
        micDevicesLoading={micDevicesLoading}
        micDevicesError={micDevicesError}
        selectedMicDeviceKey={selectedMicDeviceKey}
        onSelectMicDevice={(nextKey) => {
          setSelectedMicDeviceKey(nextKey);
          if (typeof window !== 'undefined') {
            if (nextKey) {
              window.localStorage.setItem(MIC_SELECTION_STORAGE_KEY, nextKey);
            } else {
              window.localStorage.removeItem(MIC_SELECTION_STORAGE_KEY);
            }
          }
        }}
        micTestRunning={micTestRunning}
        micLevel={micLevel}
        micDetectedOnce={micDetectedOnce}
        onRefreshMicDevices={refreshMicDevices}
        onToggleMicTest={() => (micTestRunning ? stopMicTest() : startMicTest())}
      />
        <DebugModeTools
          enabled={debugModeEnabled}
          onToggle={() => setDebugModeEnabled((prev) => !prev)}
          errors={debugErrors}
          latestError={errorText}
          onClearErrors={() => {
            setDebugErrors([]);
            setErrorText('');
          }}
        />
      </>
    );
  }

  return (
    <>
    <div className="flex h-screen bg-white text-gray-900 font-sans">
      <Sidebar
        patients={patients}
        currentPatientId={currentPatientId}
        onSelectPatient={setCurrentPatientId}
        onDeletePatient={deletePatient}
        onAddPatient={addPatient}
      />

      <main className="flex-1 flex flex-col min-h-screen">
        {currentPatient ? (
          <MainContent
            patient={currentPatient}
            onUpdatePatient={updatePatient}
            recording={recording}
            isStartingRecording={isStartingRecording}
            onToggleRecording={toggleRecording}
            statusText={statusText}
            isGeneratingSoap={isGeneratingSoap}
            onCopySoap={() => copySoapToClipboard(currentPatient)}
            copyMessage={copyMessage}
            onOpenSetup={() => {
              refreshSetupStatus();
              refreshMicDevices();
              setSetupVisible(true);
            }}
          />
        ) : (
          <EmptyState onAddPatient={addPatient} />
        )}
      </main>
    </div>
      <DebugModeTools
        enabled={debugModeEnabled}
        onToggle={() => setDebugModeEnabled((prev) => !prev)}
        errors={debugErrors}
        latestError={errorText}
        onClearErrors={() => {
          setDebugErrors([]);
          setErrorText('');
        }}
      />
    </>
  );
}

function DebugModeTools({ enabled, onToggle, errors, latestError, onClearErrors }) {
  return (
    <>
      <button
        type="button"
        className={`debug-mode-toggle ${enabled ? 'on' : 'off'}`}
        onClick={onToggle}
        aria-pressed={enabled}
        title="Toggle debug mode"
      >
        Debug {enabled ? 'ON' : 'OFF'}
      </button>

      {enabled && (
        <section className="debug-panel" aria-live="polite">
          <div className="debug-panel-header">
            <h3>Debug Errors</h3>
            <button type="button" onClick={onClearErrors}>
              Clear
            </button>
          </div>
          {latestError && <p className="debug-panel-latest">Latest: {latestError}</p>}
          {errors.length === 0 ? (
            <p className="debug-panel-empty">No errors captured.</p>
          ) : (
            <ul className="debug-panel-list">
              {errors.map((entry) => (
                <li key={entry.id}>
                  <span>[{entry.source}]</span> {entry.message}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </>
  );
}

function StartupSetupScreen({
  setupStatus,
  setupLoading,
  setupError,
  modelDownloads,
  modelDeleting,
  onDownloadModel,
  onDeleteModel,
  onStartUsing,
  vadSensitivity,
  setVadSensitivity,
  micDevices,
  micDevicesLoading,
  micDevicesError,
  selectedMicDeviceKey,
  onSelectMicDevice,
  micTestRunning,
  micLevel,
  micDetectedOnce,
  onRefreshMicDevices,
  onToggleMicTest
}) {
  const models = setupStatus?.models || [];
  const canStart = !!setupStatus?.all_ready;
  const hasMicOptions = micDevices.length > 0;
  const meterPercent = `${Math.round(Math.max(0, Math.min(1, micLevel)) * 100)}%`;
  const micStatusText = micTestRunning
    ? micDetectedOnce
      ? 'Input detected'
      : 'No input detected yet'
    : micDetectedOnce
      ? 'Test passed. Microphone input was detected.'
      : 'Run a quick microphone test before starting.';

  return (
    <div className="setup-screen-root">
      <div className="setup-card-shell">
        <h1 className="setup-title">Welcome to MedScribeAI</h1>
        <p className="setup-subtitle">
          Please download the required resources below before using MedScribeAI.
        </p>

        {setupStatus?.models_root && (
          <p className="setup-root-path">Find all app local storage at {setupStatus.models_root}</p>
        )}

        <div className="setup-mic-panel">
          <div>
            <h3 className="setup-vad-title">Microphone</h3>
            <p className="setup-vad-description">
              Pick the input device used for recording. Use test mode to confirm speech is being captured.
            </p>
          </div>
          <div className="setup-mic-actions">
            <select
              id="setup-mic-select"
              value={selectedMicDeviceKey}
              onChange={(e) => onSelectMicDevice(e.target.value)}
              className="setup-mic-select"
              disabled={micDevicesLoading || !hasMicOptions}
            >
              {!hasMicOptions && <option value="">No microphones available</option>}
              {micDevices.map((device) => (
                <option key={device.key} value={device.key}>
                  {device.name}
                  {device.is_default ? ' (Default)' : ''}
                </option>
              ))}
            </select>
            <div className="setup-mic-buttons">
              <button className="setup-mic-refresh-btn" onClick={onRefreshMicDevices}>
                Refresh
              </button>
              <button
                className="setup-mic-test-btn"
                onClick={onToggleMicTest}
                disabled={!hasMicOptions || !selectedMicDeviceKey}
              >
                {micTestRunning ? 'Stop test' : 'Test microphone'}
              </button>
            </div>
          </div>
          <div className="setup-mic-meter-track" role="progressbar" aria-valuemin={0} aria-valuemax={100}>
            <div className="setup-mic-meter-fill" style={{ width: meterPercent }} />
          </div>
          <p className={`setup-mic-status ${micDetectedOnce ? 'ok' : ''}`}>{micStatusText}</p>
          {micDevicesLoading && <p className="setup-loading">Loading microphones...</p>}
          {micDevicesError && <p className="setup-error">{micDevicesError}</p>}
          {!micDetectedOnce && !micTestRunning && (
            <p className="setup-mic-warning">
              You can continue without testing, but recording quality may be affected if the wrong device is selected.
            </p>
          )}
        </div>

        <div className="setup-vad-panel">
          <div>
            <h3 className="setup-vad-title">Voice sensitivity</h3>
            <p className="setup-vad-description">
              Controls how easily speech is detected. Lower values are stricter; higher values are
              more sensitive to quieter voices and background sounds.
            </p>
          </div>
          <select
            id="setup-vad-select"
            value={vadSensitivity}
            onChange={(e) => setVadSensitivity(Number(e.target.value))}
            className="setup-vad-select"
          >
            <option value={0}>0 - Strict</option>
            <option value={1}>1 - Conservative</option>
            <option value={2}>2 - Balanced</option>
            <option value={3}>3 - Sensitive</option>
          </select>
        </div>

        {setupLoading && <p className="setup-loading">Checking model status...</p>}

        {!setupLoading && (
          <div className="setup-model-list">
            {models.map((model) => {
              const progress = modelDownloads[model.model_id] || null;
              const isDownloading = progress?.status === 'downloading';
              const isDeleting = !!modelDeleting[model.model_id];
              const percent =
                progress && typeof progress.progress === 'number'
                  ? Math.round(progress.progress * 100)
                  : 0;

              return (
                <section className="setup-model-card" key={model.model_id}>
                  <div className="setup-model-top">
                    <div>
                      <h2 className="setup-model-name">{model.friendly_name}</h2>
                      <p className="setup-model-technical">{model.technical_name}</p>
                      <p className={`setup-model-badge ${model.ready ? 'ready' : 'missing'}`}>
                        {model.ready ? 'Ready' : 'Not downloaded'}
                      </p>
                    </div>
                    <div className="setup-model-actions">
                      <button
                        className="setup-download-btn"
                        disabled={model.ready || isDownloading || isDeleting}
                        onClick={() => onDownloadModel(model.model_id)}
                      >
                        {model.ready ? 'Downloaded' : isDownloading ? 'Downloading...' : 'Download'}
                      </button>
                      <button
                        className="setup-delete-btn"
                        disabled={!model.ready || isDownloading || isDeleting}
                        onClick={() => onDeleteModel(model.model_id)}
                      >
                        {isDeleting ? 'Deleting...' : 'Delete model'}
                      </button>
                    </div>
                  </div>

                  {isDownloading && (
                    <div className="setup-progress-wrap">
                      <div className="setup-progress-track">
                        <div className="setup-progress-fill" style={{ width: `${percent}%` }} />
                      </div>
                      <span className="setup-progress-label">{percent}%</span>
                    </div>
                  )}

                  <p className="setup-storage-line">
                    Required free space: {formatBytes(model.required_bytes)}
                  </p>
                  <p className="setup-storage-line">
                    Occupied on disk: {formatBytes(model.occupied_bytes || 0)}
                  </p>
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

function Sidebar({ patients, currentPatientId, onSelectPatient, onDeletePatient, onAddPatient }) {
  return (
    <aside className="w-72 bg-gray-50 border-r border-gray-200 flex flex-col h-screen">
      <div className="p-4 border-b border-gray-200">
        <h2 className="text-lg font-semibold text-gray-800">Patients</h2>
      </div>

      <nav className="flex-1 overflow-y-auto py-2">
        {patients.map((patient) => (
          <div key={patient.id} className="relative">
            <button
              onClick={() => onSelectPatient(patient.id)}
              className={`w-full text-left px-4 py-3 pr-12 transition-colors relative ${
                currentPatientId === patient.id
                  ? 'bg-blue-50 text-blue-700 border-l-4 border-blue-500'
                  : 'hover:bg-gray-100 border-l-4 border-transparent'
              }`}
              aria-label={`Select patient ${patient.name}`}
            >
              <div className="font-medium truncate">{patient.name}</div>
            </button>
            <button
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onDeletePatient(patient.id);
              }}
              className="sidebar-delete-btn"
              aria-label={`Delete patient ${patient.name}`}
              title={`Delete ${patient.name}`}
            >
              <TrashIcon />
            </button>
          </div>
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
  statusText,
  isGeneratingSoap,
  onCopySoap,
  copyMessage,
  onOpenSetup
}) {
  const latestChunk = getLatestTranscriptChunk(patient);

  return (
    <div className="flex-1 flex flex-col">
      <header className="px-8 py-6 border-b border-gray-200">
        <div className="workspace-header-row">
          <h2 className="text-xl font-semibold text-gray-900">Consultation</h2>
          <button className="workspace-setup-btn" onClick={onOpenSetup}>
            Model Setup
          </button>
        </div>
      </header>

      <div className="px-6 py-3 border-b border-gray-200">
        <TopTranscriptStreamBar
          latestChunk={latestChunk}
          recording={recording}
          isStartingRecording={isStartingRecording}
          onToggleRecording={onToggleRecording}
          statusText={statusText}
        />
      </div>

      <div className="flex-1 flex flex-col min-h-0">
        <div className="px-6 py-3 border-b border-gray-200 soap-patient-row">
          <label htmlFor="soap-patient-name" className="soap-patient-label">Patient Name</label>
          <input
            id="soap-patient-name"
            type="text"
            value={patient.name}
            onChange={(e) => onUpdatePatient(patient.id, 'name', e.target.value)}
            className="soap-patient-input"
            placeholder="Patient Name"
            aria-label="Patient name"
          />
        </div>
        <div className="px-6 py-4 border-b border-gray-200">
          <div className="soap-header-row">
            <div className="soap-header-left">
              <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">SOAP Note</h3>
              {isGeneratingSoap && (
                <div className="soap-loading-wrap" role="status" aria-live="polite">
                  <span className="soap-spinner" />
                  <span>Generating...</span>
                </div>
              )}
            </div>
            <div className="soap-header-actions">
              {!!copyMessage && <span className="soap-copy-feedback">{copyMessage}</span>}
              <button className="soap-copy-btn" onClick={onCopySoap}>
                Copy
              </button>
            </div>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-6">
          <SoapEditor
            patientId={patient.id}
            value={patient.soap}
            onCommit={(html) => onUpdatePatient(patient.id, 'soap', html)}
          />
        </div>
      </div>
    </div>
  );
}

function SoapEditor({ patientId, value, onCommit }) {
  const editorRef = useRef(null);

  useEffect(() => {
    const el = editorRef.current;
    if (!el) {
      return;
    }
    const next = String(value || '');
    if (el.innerHTML !== next) {
      el.innerHTML = next;
    }
  }, [patientId, value]);

  return (
    <div
      ref={editorRef}
      contentEditable
      suppressContentEditableWarning
      onBlur={(e) => onCommit(e.currentTarget.innerHTML)}
      className="prose prose-sm max-w-none outline-none focus:ring-2 focus:ring-blue-200 rounded p-2 min-h-full"
      aria-label="SOAP note editor"
    />
  );
}

function EmptyState({ onAddPatient }) {
  return (
    <div className="flex-1 flex items-center justify-center px-8">
      <div className="text-center max-w-sm">
        <h2 className="text-xl font-semibold text-gray-900">No patients yet</h2>
        <p className="mt-2 text-sm text-gray-600">Create a patient to start recording and generating SOAP notes.</p>
        <button className="mt-5 px-4 py-2 bg-blue-600 text-white rounded-md" onClick={onAddPatient}>
          Add Patient
        </button>
      </div>
    </div>
  );
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const amount = bytes / 1024 ** exp;
  return `${amount.toFixed(exp === 0 ? 0 : amount >= 10 ? 1 : 2)} ${units[exp]}`;
}

function getLatestTranscriptChunk(patient) {
  const segments = patient.segments || [];
  if (segments.length > 0) {
    return segments[segments.length - 1]?.text || '';
  }

  if (patient.transcript) {
    const lines = patient.transcript
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    return lines[lines.length - 1] || '';
  }

  return '';
}

function TopTranscriptStreamBar({
  latestChunk,
  recording,
  isStartingRecording,
  onToggleRecording,
  statusText
}) {
  const isActive = recording || isStartingRecording;
  const text = isActive
    ? latestChunk || 'Waiting for speech...'
    : 'Press record to start listening';

  return (
    <section
      className={`transcript-stream-bar ${isActive ? 'transcript-stream-bar-active' : ''}`}
      role="status"
      aria-live="polite"
      aria-label="Live transcript listening feedback"
    >
      {isActive && <div className="transcript-stream-label">Listening</div>}
      <div className="transcript-stream-viewport">
        <div className="transcript-stream-single-line">{text}</div>
      </div>
      <div className="transcript-controls">
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

function htmlToPlainText(html) {
  const clean = String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h1|h2|h3|h4|h5|h6|li)>/gi, '\n');
  const stripped = clean.replace(/<[^>]+>/g, '');
  return stripped
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function formatSoapTextAsHtml(text) {
  return markdownToHtml(text);
}

function appendSoapHtml(existingHtml, newHtml) {
  const left = String(existingHtml || '').trim();
  const right = String(newHtml || '').trim();
  if (!right) {
    return left;
  }
  if (!left) {
    return right;
  }
  return `${left}\n<p></p>\n${right}`;
}

function markdownToHtml(text) {
  const lines = String(text || '').replaceAll('\r\n', '\n').split('\n');
  const html = [];
  let inUl = false;
  let inOl = false;

  const closeLists = () => {
    if (inUl) {
      html.push('</ul>');
      inUl = false;
    }
    if (inOl) {
      html.push('</ol>');
      inOl = false;
    }
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      closeLists();
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      closeLists();
      const level = Math.min(heading[1].length, 6);
      html.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }

    const ul = line.match(/^[-*+]\s+(.+)$/);
    if (ul) {
      if (inOl) {
        html.push('</ol>');
        inOl = false;
      }
      if (!inUl) {
        html.push('<ul>');
        inUl = true;
      }
      html.push(`<li>${renderInlineMarkdown(ul[1])}</li>`);
      continue;
    }

    const ol = line.match(/^\d+\.\s+(.+)$/);
    if (ol) {
      if (inUl) {
        html.push('</ul>');
        inUl = false;
      }
      if (!inOl) {
        html.push('<ol>');
        inOl = true;
      }
      html.push(`<li>${renderInlineMarkdown(ol[1])}</li>`);
      continue;
    }

    closeLists();
    const soapHeader = line.match(/^(Subjective|Objective|Assessment|Plan)\s*:?\s*$/i);
    if (soapHeader) {
      const title = soapHeader[1].charAt(0).toUpperCase() + soapHeader[1].slice(1).toLowerCase();
      html.push(`<h3>${escapeHtml(title)}</h3>`);
      continue;
    }

    html.push(`<p>${renderInlineMarkdown(line)}</p>`);
  }

  closeLists();
  const out = html.join('\n').trim();
  return out || `<p>${escapeHtml(String(text || '').trim())}</p>`;
}

function renderInlineMarkdown(text) {
  let out = escapeHtml(String(text || ''));
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
  return out;
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

function TrashIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-1 12a2 2 0 01-2 2H8a2 2 0 01-2-2L5 7m5 4v6m4-6v6M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3M4 7h16" />
    </svg>
  );
}
