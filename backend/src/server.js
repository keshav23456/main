// backend/src/server.js
const express = require('express');
const cors = require('cors');
const Bull = require('bull');
const Redis = require('redis');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const path = require('path');
const fs = require('fs').promises;

const app = express();
const PORT = process.env.PORT || 3001;

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// Redis setup
const redis = Redis.createClient({
  host: process.env.REDIS_HOST || 'redis',
  port: process.env.REDIS_PORT || 6379
});

// Bull queue setup
const videoQueue = new Bull('video generation', {
  redis: {
    host: process.env.REDIS_HOST || 'redis',
    port: process.env.REDIS_PORT || 6379
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use('/videos', express.static('/app/videos'));

// Connect to Redis
redis.on('error', (err) => console.log('Redis Client Error', err));
redis.connect();

// Gemini prompt enhancement function
async function enhancePrompt(userPrompt) {
  const enhancementPrompt = `
You are an expert at creating detailed, technical descriptions for mathematical and scientific animations. 
Your task is to enhance the following user prompt to be more specific and suitable for creating a Manim animation.

User prompt: "${userPrompt}"

Please enhance this prompt by:
1. Adding specific mathematical or scientific concepts if applicable
2. Suggesting visual elements, colors, and animation styles
3. Defining the sequence of events in the animation
4. Specifying any mathematical formulas, shapes, or diagrams needed
5. Adding timing and transition details

Return an enhanced prompt that is detailed, clear, and perfect for generating Manim animation code.
Enhanced prompt should be 2-3 sentences long and very specific about what should be animated.

Enhanced prompt:`;

  try {
    const result = await model.generateContent(enhancementPrompt);
    const response = await result.response;
    return response.text().trim();
  } catch (error) {
    console.error('Error enhancing prompt:', error);
    return userPrompt; // Fallback to original prompt
  }
}

// Gemini code generation function
async function generateManimCode(enhancedPrompt) {
  const codePrompt = `
You are an expert Manim developer. Create a complete, working Manim scene class based on this prompt:

"${enhancedPrompt}"

Requirements:
1. Create a class that inherits from Scene
2. Use proper Manim syntax and imports
3. Include animations, transformations, and visual elements
4. Make it visually appealing with colors and smooth animations
5. Duration should be 5-10 seconds
6. Use self.play() for animations and self.wait() for pauses

Return ONLY the complete Python code, no explanations or markdown formatting.
Start with necessary imports and end with the scene class.

Example structure:
from manim import *

class GeneratedScene(Scene):
    def construct(self):
        # Your animation code here
        pass
`;

  try {
    const result = await model.generateContent(codePrompt);
    const response = await result.response;
    return response.text().trim().replace(/```python|```/g, '');
  } catch (error) {
    console.error('Error generating code:', error);
    // Fallback to a simple default animation
    return `
from manim import *

class GeneratedScene(Scene):
    def construct(self):
        text = Text("Animation Generation Failed")
        text.set_color(RED)
        self.play(Write(text))
        self.wait(2)
`;
  }
}

// Routes
app.post('/api/generate', async (req, res) => {
  try {
    const { prompt } = req.body;
    
    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    console.log('Original prompt:', prompt);

    // Step 1: Enhance the prompt using Gemini
    const enhancedPrompt = await enhancePrompt(prompt);
    console.log('Enhanced prompt:', enhancedPrompt);

    // Step 2: Generate Manim code using Gemini
    const manimCode = await generateManimCode(enhancedPrompt);
    console.log('Generated code preview:', manimCode.substring(0, 200) + '...');

    // Step 3: Add job to queue with all the data
    const job = await videoQueue.add('generateVideo', {
      originalPrompt: prompt,
      enhancedPrompt: enhancedPrompt,
      manimCode: manimCode,
      timestamp: new Date().toISOString()
    });

    // Store additional job info in Redis
    await redis.setEx(`job:${job.id}`, 3600, JSON.stringify({
      status: 'queued',
      originalPrompt: prompt,
      enhancedPrompt: enhancedPrompt,
      progress: 0,
      createdAt: new Date().toISOString()
    }));

    res.json({ 
      jobId: job.id,
      originalPrompt: prompt,
      enhancedPrompt: enhancedPrompt,
      status: 'queued'
    });

  } catch (error) {
    console.error('Error in /api/generate:', error);
    res.status(500).json({ error: 'Failed to create video generation job' });
  }
});

app.get('/api/status/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    
    // Get job status from Redis
    const jobData = await redis.get(`job:${jobId}`);
    
    if (!jobData) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const parsedJobData = JSON.parse(jobData);
    
    // Also check Bull queue for additional status info
    const job = await videoQueue.getJob(jobId);
    if (job) {
      parsedJobData.queueStatus = await job.getState();
      if (job.progress) {
        parsedJobData.progress = job.progress();
      }
    }

    res.json(parsedJobData);
  } catch (error) {
    console.error('Error getting job status:', error);
    res.status(500).json({ error: 'Failed to get job status' });
  }
});

app.get('/api/video/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const videoPath = path.join('/app/videos', `${jobId}.mp4`);
    
    try {
      await fs.access(videoPath);
      res.sendFile(videoPath);
    } catch {
      res.status(404).json({ error: 'Video not found' });
    }
  } catch (error) {
    console.error('Error serving video:', error);
    res.status(500).json({ error: 'Failed to serve video' });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    geminiConnected: !!process.env.GEMINI_API_KEY
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Gemini API ${process.env.GEMINI_API_KEY ? 'configured' : 'NOT configured'}`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');
  await redis.disconnect();
  await videoQueue.close();
  process.exit(0);
});