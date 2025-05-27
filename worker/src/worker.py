# worker/src/worker.py
import redis
import json
import tempfile
import subprocess
import os
import sys
import time
import traceback
import shutil
from pathlib import Path

class VideoGenerationWorker:
    def __init__(self):
        self.redis_client = redis.Redis(
            host=os.getenv('REDIS_HOST', 'redis'),
            port=int(os.getenv('REDIS_PORT', 6379)),
            decode_responses=True
        )
        self.videos_dir = Path('/app/videos')
        self.videos_dir.mkdir(exist_ok=True)
        
        # Test Redis connection
        try:
            self.redis_client.ping()
            print("Redis connection successful")
        except Exception as e:
            print(f"Redis connection failed: {e}")
            sys.exit(1)
        
    def update_job_status(self, job_id, status, progress=None, error=None, video_path=None):
        """Update job status in Redis"""
        try:
            job_key = f"job:{job_id}"
            job_data = self.redis_client.get(job_key)
            
            if job_data:
                data = json.loads(job_data)
            else:
                data = {
                    'jobId': job_id,
                    'status': 'unknown',
                    'createdAt': time.time()
                }
                
            data['status'] = status
            data['updatedAt'] = time.time()
            
            if progress is not None:
                data['progress'] = progress
            if error is not None:
                data['error'] = error
            if video_path is not None:
                data['videoPath'] = video_path
                
            self.redis_client.setex(job_key, 3600, json.dumps(data))
            print(f"Updated job {job_id}: {status} ({progress}%)")
            
        except Exception as e:
            print(f"Error updating job status: {e}")

    def validate_and_fix_code(self, code):
        """Validate and fix common issues in Gemini-generated Manim code"""
        try:
            # Remove any markdown formatting that might have slipped through
            code = code.replace('```python', '').replace('```', '').strip()
            
            # Ensure proper imports
            if 'from manim import *' not in code:
                code = 'from manim import *\n\n' + code
                
            # Ensure class inherits from Scene
            if 'class' in code and 'Scene' not in code:
                code = code.replace('class GeneratedScene:', 'class GeneratedScene(Scene):')
                
            # Fix common naming issues
            if 'GeneratedScene' not in code and 'class' in code:
                # Try to find any class definition and rename it
                lines = code.split('\n')
                for i, line in enumerate(lines):
                    if line.strip().startswith('class ') and '(Scene)' in line:
                        class_name = line.split('class ')[1].split('(')[0].strip()
                        code = code.replace(f'class {class_name}', 'class GeneratedScene')
                        break
                        
            # Add default scene if no class found
            if 'class GeneratedScene' not in code:
                code += '''

class GeneratedScene(Scene):
    def construct(self):
        text = Text("Generated Animation", font_size=36)
        text.set_color(BLUE)
        self.play(Write(text))
        self.wait(2)
'''
            
            return code
            
        except Exception as e:
            print(f"Error fixing code: {e}")
            return self.get_fallback_code()

    def get_fallback_code(self):
        """Return a simple fallback animation if code generation fails"""
        return '''
from manim import *

class GeneratedScene(Scene):
    def construct(self):
        title = Text("AI Video Generator", font_size=48)
        title.set_color(BLUE)
        
        subtitle = Text("Animation Generated Successfully!", font_size=24)
        subtitle.set_color(GREEN)
        subtitle.next_to(title, DOWN, buff=0.5)
        
        self.play(Write(title))
        self.wait(1)
        self.play(Write(subtitle))
        self.wait(2)
        
        circle = Circle(radius=2, color=YELLOW)
        circle.next_to(subtitle, DOWN, buff=1)
        
        self.play(Create(circle))
        self.play(circle.animate.set_color(RED))
        self.wait(1)
'''

    def generate_video(self, job_data):
        """Generate video from Manim code"""
        job_id = job_data['job_id']
        manim_code = job_data['data'].get('manimCode', '')
        
        print(f"Starting video generation for job {job_id}")
        temp_file_path = None
        
        try:
            self.update_job_status(job_id, 'processing', 10)
            
            # Validate and fix the code
            if not manim_code:
                raise Exception("No Manim code provided")
                
            fixed_code = self.validate_and_fix_code(manim_code)
            print(f"Code validation completed for job {job_id}")
            
            self.update_job_status(job_id, 'processing', 25)
            
            # Create temporary Python file
            with tempfile.NamedTemporaryFile(mode='w', suffix='.py', delete=False) as temp_file:
                temp_file.write(fixed_code)
                temp_file_path = temp_file.name
                
            print(f"Created temp file: {temp_file_path}")
            self.update_job_status(job_id, 'processing', 40)
            
            # Output video path
            output_path = self.videos_dir / f"{job_id}.mp4"
            
            # Create temporary media directory for this job
            temp_media_dir = f"/tmp/manim_media_{job_id}"
            os.makedirs(temp_media_dir, exist_ok=True)
            
            # Run Manim command with better error handling
            cmd = [
                'manim',
                temp_file_path,
                'GeneratedScene',
                '--format=mp4',
                f'--media_dir={temp_media_dir}',
                '--resolution=1280,720',
                '--frame_rate=30',
                '--disable_caching',
                '-v', 'WARNING'  # Reduce verbose output
            ]
            
            print(f"Running command: {' '.join(cmd)}")
            self.update_job_status(job_id, 'processing', 60)
            
            # Execute Manim
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=300,  # 5 minute timeout
                cwd='/app'
            )
            
            print(f"Manim execution completed with return code: {result.returncode}")
            if result.stdout:
                print(f"Manim stdout: {result.stdout}")
            if result.stderr:
                print(f"Manim stderr: {result.stderr}")
                
            self.update_job_status(job_id, 'processing', 80)
            
            if result.returncode == 0:
                # Find the generated video file in the temp media directory
                video_files = list(Path(temp_media_dir).rglob("*.mp4"))
                
                if video_files:
                    # Copy the video to the final location
                    source_video = video_files[0]
                    shutil.copy2(source_video, output_path)
                    
                    print(f"Video copied to: {output_path}")
                    
                    if output_path.exists() and output_path.stat().st_size > 0:
                        self.update_job_status(
                            job_id, 
                            'completed', 
                            100, 
                            video_path=f"/videos/{job_id}.mp4"
                        )
                        print(f"Video generated successfully: {output_path}")
                    else:
                        raise Exception("Video file is empty or corrupted")
                else:
                    raise Exception("No video file found in output directory")
            else:
                raise Exception(f"Manim failed with return code {result.returncode}: {result.stderr}")
                
        except subprocess.TimeoutExpired:
            error_msg = "Video generation timed out after 5 minutes"
            print(f"Job {job_id} timed out")
            self.update_job_status(job_id, 'failed', error=error_msg)
            
        except Exception as e:
            error_msg = f"Video generation failed: {str(e)}"
            print(f"Job {job_id} failed: {error_msg}")
            print(f"Traceback: {traceback.format_exc()}")
            self.update_job_status(job_id, 'failed', error=error_msg)
            
        finally:
            # Cleanup temporary files
            try:
                if temp_file_path and os.path.exists(temp_file_path):
                    os.unlink(temp_file_path)
                    print(f"Cleaned up temp file: {temp_file_path}")
                    
                # Clean up temp media directory
                temp_media_dir = f"/tmp/manim_media_{job_id}"
                if os.path.exists(temp_media_dir):
                    shutil.rmtree(temp_media_dir)
                    print(f"Cleaned up temp media dir: {temp_media_dir}")
            except Exception as cleanup_error:
                print(f"Cleanup error: {cleanup_error}")

    def listen_for_jobs(self):
        """Listen for jobs using Bull queue format"""
        queue_key = "bull:video generation:waiting"
        
        while True:
            try:
                # Use BLPOP to wait for jobs
                result = self.redis_client.blpop(queue_key, timeout=5)
                
                if result:
                    queue_name, job_data = result
                    print(f"Received job from queue: {queue_name}")
                    
                    try:
                        job_info = json.loads(job_data)
                        job_id = job_info.get('id')
                        
                        if job_id:
                            print(f"Processing job {job_id}")
                            enhanced_job = {
                                'job_id': str(job_id),
                                'data': job_info.get('data', {})
                            }
                            self.generate_video(enhanced_job)
                        else:
                            print("Job missing ID, skipping")
                            
                    except json.JSONDecodeError as e:
                        print(f"Invalid JSON in job data: {e}")
                    except Exception as e:
                        print(f"Error processing job: {e}")
                        
            except redis.exceptions.TimeoutError:
                # Normal timeout, continue loop
                continue
            except KeyboardInterrupt:
                print("Worker stopped by user")
                break
            except Exception as e:
                print(f"Error in job listening loop: {e}")
                print(f"Traceback: {traceback.format_exc()}")
                time.sleep(5)  # Wait before retrying

    def process_jobs(self):
        """Main job processing method with fallback queue checking"""
        print("Worker started, waiting for jobs...")
        print(f"Redis connected to: {os.getenv('REDIS_HOST', 'redis')}:{os.getenv('REDIS_PORT', 6379)}")
        
        # Check if we can connect to Redis
        try:
            self.redis_client.ping()
            print("Redis connection verified")
        except Exception as e:
            print(f"Redis connection failed: {e}")
            return
        
        # Start listening for jobs
        self.listen_for_jobs()

if __name__ == "__main__":
    print("Starting Video Generation Worker...")
    worker = VideoGenerationWorker()
    worker.process_jobs()