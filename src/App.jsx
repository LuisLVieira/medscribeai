import React, { useState } from 'react';

// Main App Component
export default function App() {
  // State for patients
  const [patients, setPatients] = useState([
    {
      id: '1',
      name: 'John Smith',
      transcript: `[10:32 AM] Patient: I've been having headaches for the past two weeks.\n\n[10:32 AM] Doctor: Can you describe the headaches? Where exactly do you feel them?\n\n[10:33 AM] Patient: Mostly on the right side of my head, like a throbbing pain.\n\n[10:33 AM] Doctor: How often do they occur?\n\n[10:34 AM] Patient: Almost daily, usually in the afternoon.\n\n[10:34 AM] Doctor: Any visual changes or nausea?\n\n[10:35 AM] Patient: Sometimes I feel a bit nauseous, but no vision problems.`,
      soap: `<h3>Subjective</h3>\n<p>Patient reports recurring headaches for 2 weeks, primarily right-sided, throbbing in nature. Occurs daily, mostly afternoon. Associated nausea occasionally. No visual disturbances.</p>\n\n<h3>Objective</h3>\n<p>Vitals stable. Neurological exam normal. No focal deficits.</p>\n\n<h3>Assessment</h3>\n<p>Migraine headaches, probable.</p>\n\n<h3>Plan</h3>\n<p>1. Start sumatriptan 50mg as needed\n2. Keep headache diary\n3. Follow up in 2 weeks\n4. MRI if symptoms worsen</p>`
    },
    {
      id: '2',
      name: 'Sarah Johnson',
      transcript: `[2:15 PM] Patient: I think I sprained my ankle playing basketball yesterday.\n\n[2:15 PM] Doctor: Let me take a look. Can you walk on it?\n\n[2:16 PM] Patient: Yes, but it hurts quite a bit.\n\n[2:16 PM] Doctor: Any swelling or bruising?\n\n[2:17 PM] Patient: It's pretty swollen and a bit purple on the outside.`,
      soap: `<h3>Subjective</h3>\n<p>Ankle injury during basketball 24 hours ago. Moderate pain with ambulation.</p>\n\n<h3>Objective</h3>\n<p>Edema present lateral ankle. Ecchymosis noted. Tender to palpation. ROM limited by pain.</p>\n\n<h3>Assessment</h3>\n<p>Lateral ankle sprain, grade 2.</p>\n\n<h3>Plan</h3>\n<p>RICE protocol, NSAIDs, ankle brace, follow up 1 week.</p>`
    }
  ]);

  const [currentPatientId, setCurrentPatientId] = useState('1');
  const [recording, setRecording] = useState(false);

  // Add new patient
  const addPatient = () => {
    const newId = Date.now().toString();
    const newPatient = {
      id: newId,
      name: 'New Patient',
      transcript: '',
      soap: `<h3>Subjective</h3>\n<p>Enter patient symptoms and history...</p>\n\n<h3>Objective</h3>\n<p>Enter physical exam findings...</p>\n\n<h3>Assessment</h3>\n<p>Enter diagnosis...</p>\n\n<h3>Plan</h3>\n<p>Enter treatment plan...</p>`
    };
    setPatients([...patients, newPatient]);
    setCurrentPatientId(newId);
  };

  // Update patient
  const updatePatient = (id, field, value) => {
    setPatients(patients.map(p => 
      p.id === id ? { ...p, [field]: value } : p
    ));
  };

  const currentPatient = patients.find(p => p.id === currentPatientId);

  return (
    <div className="flex h-screen bg-white text-gray-900 font-sans">
      {/* Sidebar */}
      <Sidebar 
        patients={patients}
        currentPatientId={currentPatientId}
        onSelectPatient={setCurrentPatientId}
        onAddPatient={addPatient}
      />

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-h-screen">
        {currentPatient && (
          <MainContent
            patient={currentPatient}
            onUpdatePatient={updatePatient}
          />
        )}
      </main>

      {/* Floating Record Button */}
      {!recording && (
        <button
          onClick={() => setRecording(true)}
          className="fixed bottom-8 left-1/2 transform -translate-x-1/2 w-16 h-16 bg-red-500 hover:bg-red-600 text-white rounded-full shadow-lg flex items-center justify-center z-20 transition-colors"
          aria-label="Start recording"
        >
          <MicrophoneIcon />
        </button>
      )}

      {/* Recording Bar */}
      {recording && (
        <RecordingBar onClose={() => setRecording(false)} />
      )}
    </div>
  );
}

// Sidebar Component
function Sidebar({ patients, currentPatientId, onSelectPatient, onAddPatient }) {
  return (
    <aside className="w-72 bg-gray-50 border-r border-gray-200 flex flex-col h-screen">
      <div className="p-4 border-b border-gray-200">
        <h2 className="text-lg font-semibold text-gray-800">Patients</h2>
      </div>
      
      <nav className="flex-1 overflow-y-auto py-2">
        {patients.map(patient => (
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

// Main Content Component
function MainContent({ patient, onUpdatePatient }) {
  return (
    <div className="flex-1 flex flex-col">
      {/* Patient Name Header */}
      <header className="px-8 py-6 border-b border-gray-200">
        <input
          type="text"
          value={patient.name}
          onChange={(e) => onUpdatePatient(patient.id, 'name', e.target.value)}
          className="text-3xl font-semibold text-gray-900 border-none outline-none w-full bg-transparent focus:ring-0"
          placeholder="Patient Name"
          aria-label="Patient name"
        />
      </header>

      {/* Two Column Layout */}
      <div className="flex-1 flex divide-x divide-gray-200">
        {/* Left Column - Transcript */}
        <div className="flex-1 flex flex-col">
          <div className="px-6 py-4 border-b border-gray-200">
            <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">
              Conversation Transcript
            </h3>
          </div>
          <div className="flex-1 overflow-y-auto p-6">
            <div className="prose prose-sm max-w-none">
              {patient.transcript ? (
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
        </div>

        {/* Right Column - SOAP Note */}
        <div className="flex-1 flex flex-col">
          <div className="px-6 py-4 border-b border-gray-200">
            <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">
              SOAP Note
            </h3>
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

// Recording Bar Component
function RecordingBar({ onClose }) {
  const [isPaused, setIsPaused] = useState(false);

  return (
    <div className="fixed bottom-0 left-0 right-0 bg-gray-800 text-white shadow-2xl z-30 animate-slide-up">
      <div className="flex items-center justify-between px-6 py-4 h-20">
        {/* Audio Visualizer */}
        <div className="flex items-center gap-1">
          <div className="text-sm font-medium mr-4">Recording</div>
          <AudioVisualizer />
        </div>

        {/* Controls */}
        <div className="flex items-center gap-4">
          <button
            onClick={() => setIsPaused(!isPaused)}
            className="w-10 h-10 bg-gray-700 hover:bg-gray-600 rounded-full flex items-center justify-center transition-colors"
            aria-label={isPaused ? 'Resume' : 'Pause'}
          >
            {isPaused ? <PlayIcon /> : <PauseIcon />}
          </button>
          <button
            onClick={onClose}
            className="w-10 h-10 bg-red-600 hover:bg-red-700 rounded-full flex items-center justify-center transition-colors"
            aria-label="Stop recording"
          >
            <StopIcon />
          </button>
        </div>

        {/* Microphone Selector */}
        <div className="flex items-center gap-3">
          <label htmlFor="mic-select" className="text-sm">Microphone:</label>
          <select
            id="mic-select"
            className="bg-gray-700 text-white px-3 py-2 rounded border border-gray-600 outline-none focus:border-blue-500 text-sm"
          >
            <option>Built-in Microphone</option>
            <option>USB Microphone</option>
            <option>External Mic (Bluetooth)</option>
            <option>Headset Microphone</option>
          </select>
        </div>

        {/* Close Button */}
        <button
          onClick={onClose}
          className="w-8 h-8 hover:bg-gray-700 rounded flex items-center justify-center transition-colors"
          aria-label="Close recording bar"
        >
          <XIcon />
        </button>
      </div>
    </div>
  );
}

// Audio Visualizer Component
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

// Icon Components
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

function PlayIcon() {
  return (
    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
      <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
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
