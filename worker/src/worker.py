# worker/src/worker.py
import redis
import json
import tempfile
import subprocess
import os
import sys
import time
import traceback
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
        
    def update_job_status(self, job_id, status, progress=None, error=None, video_path=None):
        """Update job status in Redis"""
        try:
            job_key = f"job:{job_id}"
            job_data = self.redis_client.get(job_key)
            
            if job_data:
                data = json.loads(job_data)
            else:
                data = {}
                
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
                
            # Add default scene if no class found
            if 'class GeneratedScene' not in code:
                code += '''

class GeneratedScene(Scene):
    def construct(self):
        text = Text("Generated Animation")
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
        title = Text("Prompt-to-Video Generator", font_size=48)
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
        manim_code = job_data['data']['manimCode']
        
        try:
            self.update_job_status(job_id, 'processing', 10)
            
            # Validate and fix the code
            fixed_code = self.validate_and_fix_code(manim_code)
            
            self.update_job_status(job_id, 'processing', 25)
            
            # Create temporary Python file
            with tempfile.NamedTemporaryFile(mode='w', suffix='.py', delete=False) as temp_file:
                temp_file.write(fixed_code)
                temp_file_path = temp_file.name
                
            self.update_job_status(job_id, 'processing', 40)
            
            # Output video path
            output_path = self.videos_dir / f"{job_id}.mp4"
            
            # Run Manim command
            cmd = [
                'manim',
                temp_file_path,
                'GeneratedScene',
                '--format=mp4',
                '--media_dir=/tmp/manim_media',
                f'--output_file={output_path}',
                '--resolution=720,480',
                '--frame_rate=30'
            ]
            
            print(f"Running command: {' '.join(cmd)}")
            self.update_job_status(job_id, 'processing', 60)
            
            # Execute Manim
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=300  # 5 minute timeout
            )
            
            self.update_job_status(job_id, 'processing', 80)
            
            if result.returncode == 0:
                # Check if video file was created
                if output_path.exists():
                    self.update_job_status(
                        job_id, 
                        'completed', 
                        100, 
                        video_path=f"/videos/{job_id}.mp4"
                    )
                    print(f"Video generated successfully: {output_path}")
                else:
                    raise Exception("Video file was not created")
            else:
                raise Exception(f"Manim failed: {result.stderr}")
                
        except subprocess.TimeoutExpired:
            error_msg = "Video generation timed out"
            print(f"Job {job_id} timed out")
            self.update_job_status(job_id, 'failed', error=error_msg)
            
        except Exception as e:
            error_msg = f"Video generation failed: {str(e)}"
            print(f"Job {job_id} failed: {error_msg}")
            print(f"Traceback: {traceback.format_exc()}")
            self.update_job_status(job_id, 'failed', error=error_msg)
            
        finally:
            # Cleanup temporary file
            try:
                if 'temp_file_path' in locals():
                    os.unlink(temp_file_path)
            except:
                pass

    def process_jobs(self):
        """Main job processing loop"""
        print("Worker started, waiting for jobs...")
        
        while True:
            try:
                # Check for jobs in the Bull queue (using Redis lists)
                job_data = self.redis_client.blpop('bull:video generation:waiting', timeout=5)
                
                if job_data:
                    job_json = job_data[1]
                    job_info = json.loads(job_json)
                    
                    print(f"Processing job: {job_info}")
                    
                    # Extract job ID and data
                    job_id = job_info.get('id')
                    if job_id:
                        enhanced_job = {
                            'job_id': job_id,
                            'data': job_info.get('data', {})
                        }
                        self.generate_video(enhanced_job)
                    else:
                        print("Job missing ID, skipping")
                        
            except redis.exceptions.TimeoutError:
                # Normal timeout, continue loop
                continue
            except KeyboardInterrupt:
                print("Worker stopped by user")
                break
            except Exception as e:
                print(f"Error in job processing loop: {e}")
                print(f"Traceback: {traceback.format_exc()}")
                time.sleep(5)  # Wait before retrying

if __name__ == "__main__":
    worker = VideoGenerationWorker()
    worker.process_jobs()