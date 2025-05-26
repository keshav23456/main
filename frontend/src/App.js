import React, { useState, useEffect } from 'react';
import { Play, Loader2, Sparkles, Code, Video, CheckCircle } from 'lucide-react';

const API_BASE = process.env.REACT_APP_API_URL || 'http://localhost:3001/api';

function App() {
  const [prompt, setPrompt] = useState('');
  const [currentJob, setCurrentJob] = useState(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState('');
  const [jobHistory, setJobHistory] = useState([]);
  const [showDetails, setShowDetails] = useState(false);

  const generateVideo = async () => {
    if (!prompt.trim()) {
      setError('Please enter a prompt');
      return;
    }

    setIsGenerating(true);
    setError('');
    setCurrentJob(null);

    try {
      const response = await fetch(`${API_BASE}/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ prompt: prompt.trim() }),
      });

      if (!response.ok) {
        throw new Error(`Server error: ${response.status}`);
      }

      const result = await response.json();
      
      const newJob = {
        ...result,
        status: 'enhancing',
        progress: 0,
        steps: {
          enhancing: false,
          generating: false,
          rendering: false,
          completed: false
        }
      };
      
      setCurrentJob(newJob);
      setJobHistory(prev => [newJob, ...prev.slice(0, 4)]); // Keep last 5 jobs
      
      // Start polling for status
      pollJobStatus(result.jobId);
      
    } catch (err) {
      console.error('Error generating video:', err);
      setError(`Failed to start video generation: ${err.message}`);
      setIsGenerating(false);
    }
  };

  const pollJobStatus = async (jobId) => {
    let attempts = 0;
    const maxAttempts = 120; // 10 minutes maximum
    
    const poll = async () => {
      try {
        const response = await fetch(`${API_BASE}/status/${jobId}`);
        
        if (!response.ok) {
          throw new Error(`Status check failed: ${response.status}`);
        }
        
        const status = await response.json();
        
        // Update job status and steps
        setCurrentJob(prev => {
          if (!prev || prev.jobId !== jobId) return prev;
          
          const steps = { ...prev.steps };
          
          if (status.status === 'queued') {
            steps.enhancing = true;
          } else if (status.status === 'processing') {
            steps.enhancing = true;
            steps.generating = true;
            if (status.progress > 50) {
              steps.rendering = true;
            }
          } else if (status.status === 'completed') {
            steps.enhancing = true;
            steps.generating = true;
            steps.rendering = true;
            steps.completed = true;
          }
          
          return {
            ...prev,
            ...status,
            steps
          };
        });
        
        // Update job history
        setJobHistory(prev => 
          prev.map(job => 
            job.jobId === jobId 
              ? { ...job, ...status }
              : job
          )
        );
        
        if (status.status === 'completed' || status.status === 'failed') {
          setIsGenerating(false);
          return;
        }
        
        attempts++;
        if (attempts < maxAttempts) {
          setTimeout(poll, 2000); // Poll every 2 seconds
        } else {
          setError('Video generation timed out');
          setIsGenerating(false);
        }
        
      } catch (err) {
        console.error('Error polling status:', err);
        attempts++;
        if (attempts < maxAttempts) {
          setTimeout(poll, 5000); // Retry after 5 seconds on error
        } else {
          setError(`Status polling failed: ${err.message}`);
          setIsGenerating(false);
        }
      }
    };
    
    poll();
  };

  const ProcessStep = ({ icon: Icon, title, isActive, isCompleted, description }) => (
    <div className={`flex items-start space-x-3 p-3 rounded-lg transition-all duration-300 ${
      isActive ? 'bg-blue-50 border border-blue-200' : 
      isCompleted ? 'bg-green-50 border border-green-200' : 
      'bg-gray-50 border border-gray-200'
    }`}>
      <div className={`p-2 rounded-full ${
        isActive ? 'bg-blue-500 text-white animate-pulse' :
        isCompleted ? 'bg-green-500 text-white' :
        'bg-gray-300 text-gray-600'
      }`}>
        {isCompleted ? <CheckCircle size={20} /> : <Icon size={20} />}
      </div>
      <div className="flex-1">
        <h4 className={`font-medium ${
          isActive ? 'text-blue-900' :
          isCompleted ? 'text-green-900' :
          'text-gray-700'
        }`}>
          {title}
        </h4>
        <p className={`text-sm ${
          isActive ? 'text-blue-700' :
          isCompleted ? 'text-green-700' :
          'text-gray-500'
        }`}>
          {description}
        </p>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-50 to-blue-50 p-4">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-4xl font-bold text-gray-800 mb-2 flex items-center justify-center gap-2">
            <Sparkles className="text-purple-500" size={32} />
            AI Video Generator
          </h1>
          <p className="text-gray-600">Transform your ideas into animated videos using AI and Manim</p>
        </div>

        {/* Input Section */}
        <div className="bg-white rounded-xl shadow-lg p-6 mb-6">
          <label className="block text-sm font-medium text-gray-700 mb-2">
            Describe your animation:
          </label>
          <div className="flex gap-3">
            <textarea
              className="flex-1 p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent resize-none"
              rows="3"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="e.g., Create a visualization of the Pythagorean theorem with colorful triangles and mathematical formulas"
              disabled={isGenerating}
            />
            <button
              onClick={generateVideo}
              disabled={isGenerating || !prompt.trim()}
              className="px-6 py-3 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors duration-200 flex items-center gap-2 font-medium"
            >
              {isGenerating ? (
                <>
                  <Loader2 className="animate-spin" size={20} />
                  Generating...
                </>
              ) : (
                <>
                  <Play size={20} />
                  Generate Video
                </>
              )}
            </button>
          </div>
        </div>

        {/* Error Display */}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
            <p className="text-red-700">{error}</p>
          </div>
        )}

        {/* Current Job Processing */}
        {currentJob && (
          <div className="bg-white rounded-xl shadow-lg p-6 mb-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-gray-800">Processing Your Video</h3>
              <button
                onClick={() => setShowDetails(!showDetails)}
                className="text-purple-600 hover:text-purple-800 text-sm font-medium"
              >
                {showDetails ? 'Hide Details' : 'Show Details'}
              </button>
            </div>

            {/* Progress Steps */}
            <div className="space-y-3 mb-4">
              <ProcessStep
                icon={Sparkles}
                title="AI Enhancement"
                isActive={currentJob.status === 'queued' && !currentJob.steps.enhancing}
                isCompleted={currentJob.steps.enhancing}
                description="Enhancing your prompt with AI for better animations"
              />
              <ProcessStep
                icon={Code}
                title="Code Generation"
                isActive={currentJob.status === 'processing' && currentJob.progress < 50}
                isCompleted={currentJob.steps.generating}
                description="Generating Manim animation code"
              />
              <ProcessStep
                icon={Video}
                title="Video Rendering"
                isActive={currentJob.status === 'processing' && currentJob.progress >= 50}
                isCompleted={currentJob.steps.rendering}
                description="Rendering your animated video"
              />
            </div>

            {/* Progress Bar */}
            <div className="bg-gray-200 rounded-full h-2 mb-4">
              <div
                className="bg-purple-600 h-2 rounded-full transition-all duration-500"
                style={{ width: `${currentJob.progress || 0}%` }}
              />
            </div>

            {/* Enhanced Prompt Display */}
            {showDetails && currentJob.enhancedPrompt && (
              <div className="bg-gray-50 rounded-lg p-4 mb-4">
                <h4 className="font-medium text-gray-800 mb-2">AI Enhanced Prompt:</h4>
                <p className="text-gray-700 text-sm italic">"{currentJob.enhancedPrompt}"</p>
              </div>
            )}

            {/* Video Player */}
            {currentJob.status === 'completed' && (
              <div className="bg-black rounded-lg overflow-hidden">
                <video
                  controls
                  className="w-full h-auto"
                  src={`${API_BASE.replace('/api', '')}/videos/${currentJob.jobId}.mp4`}
                >
                  Your browser does not support the video tag.
                </video>
              </div>
            )}

            {/* Error Display */}
            {currentJob.status === 'failed' && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                <p className="text-red-700">
                  Generation failed: {currentJob.error || 'Unknown error'}
                </p>
              </div>
            )}
          </div>
        )}

        {/* Job History */}
        {jobHistory.length > 0 && (
          <div className="bg-white rounded-xl shadow-lg p-6">
            <h3 className="text-lg font-semibold text-gray-800 mb-4">Recent Videos</h3>
            <div className="grid gap-4 md:grid-cols-2">
              {jobHistory.slice(0, 4).map((job) => (
                <div key={job.jobId} className="border border-gray-200 rounded-lg p-4">
                  <p className="text-sm text-gray-600 mb-2 truncate">
                    "{job.originalPrompt}"
                  </p>
                  <div className="flex items-center justify-between">
                    <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                      job.status === 'completed' ? 'bg-green-100 text-green-800' :
                      job.status === 'failed' ? 'bg-red-100 text-red-800' :
                      'bg-yellow-100 text-yellow-800'
                    }`}>
                      {job.status}
                    </span>
                    {job.status === 'completed' && (
                      <a
                        href={`${API_BASE.replace('/api', '')}/videos/${job.jobId}.mp4`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-purple-600 hover:text-purple-800 text-sm font-medium"
                      >
                        View Video
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;