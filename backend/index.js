const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const util = require("util");

const unlinkAsync = util.promisify(fs.unlink);

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}

// User agents to rotate through
const userAgents = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
];

// Get random user agent
const getRandomUserAgent = () => {
  return userAgents[Math.floor(Math.random() * userAgents.length)];
};

// Retry function with exponential backoff
const retry = async (fn, retries = 3, delay = 1000) => {
  try {
    return await fn();
  } catch (error) {
    if (retries === 0) throw error;
    await new Promise(resolve => setTimeout(resolve, delay));
    return retry(fn, retries - 1, delay * 2);
  }
};

// Validate YouTube URL
const isValidYouTubeUrl = (url) => {
  const pattern = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+$/;
  return pattern.test(url);
};

app.post("/api/clip", async (req, res) => {
  const timestamp = Date.now();
  const tempMuxedPathBase = path.join(uploadsDir, `temp-muxed-${timestamp}`);
  let tempMuxedPath = null;
  const finalOutputPath = path.join(uploadsDir, `clip-${timestamp}.mp4`);

  try {
    const { url, startTime, endTime } = req.body;
    console.log('Received request:', { url, startTime, endTime });

    if (!url || !startTime || !endTime) {
      console.log('Missing required fields:', { url: !!url, startTime: !!startTime, endTime: !!endTime });
      return res.status(400).json({ error: "url, startTime, and endTime are required" });
    }

    if (!isValidYouTubeUrl(url)) {
      console.log('Invalid YouTube URL:', url);
      return res.status(400).json({ error: "Invalid YouTube URL" });
    }

    console.log(`Attempting to download muxed video/audio for clipping from ${url}`);
    console.log(`Using temporary muxed base: ${tempMuxedPathBase}`);

    // Download video segment with yt-dlp
    const runYtDlpDownload = (outputPathBase, startTime, endTime) => {
      return new Promise((resolve, reject) => {
        const outputPathTemplate = outputPathBase + ".%(ext)s";
        let detectedPath = null;
        let processStderr = "";
        let processStdout = "";
        
        console.log(`Starting yt-dlp partial download for muxed format to template '${outputPathTemplate}'`);
        const section = `*${startTime}-${endTime}`;

        const ytDlpArgs = [
          url,
          "-f",
          "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
          "--download-sections",
          section,
          "-o",
          outputPathTemplate,
          "--no-check-certificates",
          "--no-warnings",
          "--add-header",
          "referer:youtube.com",
          "--add-header",
          "user-agent:" + getRandomUserAgent(),
          "--merge-output-format",
          "mp4",
          "--verbose",
          "--extractor-args",
          "youtube:player_client=android",
          "--geo-bypass",
          "--no-playlist",
          "--no-playlist-reverse",
          "--socket-timeout",
          "30",
          "--retries",
          "3",
          "--fragment-retries",
          "3",
          "--extractor-retries",
          "3",
          "--ignore-errors",
          "--prefer-insecure",
          "--force-ipv4",
          "--no-cookies",
          "--no-cache-dir",
          "--extractor-args",
          "youtube:player_skip=webpage,configs",
          "--extractor-args",
          "youtube:player_params={\"hl\":\"en\",\"gl\":\"US\"}",
          "--extractor-args",
          "youtube:player_client=android",
          "--extractor-args",
          "youtube:player_skip=webpage,configs",
          "--extractor-args",
          "youtube:player_params={\"hl\":\"en\",\"gl\":\"US\"}"
        ];

        console.log('yt-dlp command:', 'yt-dlp ' + ytDlpArgs.join(' '));

        const ytDlp = spawn("yt-dlp", ytDlpArgs);

        ytDlp.stderr.on("data", (data) => {
          console.error(`yt-dlp stderr (muxed): ${data}`);
          processStderr += data.toString();
        });

        ytDlp.stdout.on("data", (data) => {
          const output = data.toString();
          console.log(`yt-dlp stdout (muxed): ${output}`);
          processStdout += output;
          const destinationMatch = output.match(/\[download\] Destination: (.+)/);
          if (destinationMatch && destinationMatch[1]) {
            const filePath = destinationMatch[1].trim();
            if (filePath.startsWith(outputPathBase)) {
              console.log(`Detected download destination (muxed): ${filePath}`);
              detectedPath = filePath;
            }
          }
        });

        ytDlp.on("close", (code) => {
          if (code === 0) {
            if (detectedPath && fs.existsSync(detectedPath)) {
              console.log(`yt-dlp download successful (muxed): ${detectedPath}`);
              resolve(detectedPath);
              return;
            }
            // Fallback: search for file
            console.log(`Could not determine output file from stdout (muxed), attempting to find files...`);
            try {
              const files = fs.readdirSync(uploadsDir);
              const foundFile = files.find(f => f.startsWith(path.basename(outputPathBase)));
              if (foundFile) {
                const fullPath = path.join(uploadsDir, foundFile);
                if (fs.existsSync(fullPath)) {
                  console.log(`Found downloaded file (muxed) by searching: ${fullPath}`);
                  resolve(fullPath);
                  return;
                }
              }
            } catch (findErr) {
              console.error(`Error searching for downloaded file (muxed):`, findErr);
            }
            console.error(`yt-dlp process (muxed) exited code 0 but no output file found.`);
            reject(new Error(`yt-dlp (muxed) indicated success, but no output file was found. Stderr: ${processStderr}`));
          } else {
            // Enhanced error handling
            let errorMessage = "Failed to download video";
            if (processStderr.includes("This content isn't available")) {
              errorMessage = "This video is not available. It might be private, age-restricted, or region-locked.";
            } else if (processStderr.includes("Video unavailable")) {
              errorMessage = "This video is unavailable. It might have been removed or made private.";
            } else if (processStderr.includes("Sign in to confirm your age")) {
              errorMessage = "This video is age-restricted and cannot be downloaded.";
            } else if (processStderr.includes("This video is private")) {
              errorMessage = "This video is private and cannot be downloaded.";
            } else if (processStderr.includes("This video is not available in your country")) {
              errorMessage = "This video is not available in your region.";
            }
            console.error(`yt-dlp process (muxed) exited with code ${code}. Stderr: ${processStderr}`);
            reject(new Error(errorMessage));
          }
        });

        ytDlp.on("error", (err) => {
          console.error(`Failed to start yt-dlp process (muxed):`, err);
          reject(new Error(`Failed to start yt-dlp (muxed): ${err.message}`));
        });
      });
    };

    // Download segment with retry logic
    const maxRetries = 3;
    let lastError = null;
    
    for (let i = 0; i < maxRetries; i++) {
      try {
        tempMuxedPath = await runYtDlpDownload(tempMuxedPathBase, startTime, endTime);
        break;
      } catch (downloadError) {
        lastError = downloadError;
        console.error(`Attempt ${i + 1} failed:`, downloadError);
        if (i < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, 2000 * (i + 1)));
        }
      }
    }

    if (!tempMuxedPath) {
      return res.status(400).json({
        error: lastError?.message || "Failed to download video after multiple attempts. Please try again later."
      });
    }

    console.log(`Clipping muxed file (${tempMuxedPath}) from ${startTime} to ${endTime} into ${finalOutputPath}`);

    // Final trim with ffmpeg for compatibility
    const ffmpeg = spawn("ffmpeg", [
      "-i", tempMuxedPath,
      "-c:v", "libx264",
      "-profile:v", "high",
      "-level", "4.0",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "128k",
      "-movflags", "+faststart",
      "-y", finalOutputPath
    ]);

    let ffmpegStderr = "";
    ffmpeg.stderr.on("data", (data) => {
      console.log(`ffmpeg: ${data}`);
      ffmpegStderr += data.toString();
    });

    await new Promise((resolve, reject) => {
      ffmpeg.on("close", (code) => {
        if (code === 0) {
          if (fs.existsSync(finalOutputPath) && fs.statSync(finalOutputPath).size > 0) {
            console.log("FFmpeg remux successful.");
            resolve();
          } else {
            console.error(`FFmpeg exited code 0 but output file missing or empty: ${finalOutputPath}`);
            reject(new Error(`FFmpeg remux failed: Output file missing or empty. Stderr: ${ffmpegStderr}`));
          }
        } else {
          console.error(`FFmpeg process exited with code ${code}. Stderr: ${ffmpegStderr}`);
          reject(new Error(`FFmpeg remux failed with code ${code}. Stderr: ${ffmpegStderr}`));
        }
      });
      ffmpeg.on("error", (err) => {
        console.error("Failed to start ffmpeg process:", err);
        reject(new Error(`Failed to start ffmpeg: ${err.message}`));
      });
    });

    console.log(`Processing complete. Final clip available at: ${finalOutputPath}`);

    // Send the final clipped video file as a download
    res.download(finalOutputPath, "clip.mp4", async (err) => {
      if (err) {
        console.error("Error sending file:", err);
      }
      // Cleanup after sending
      try {
        if (fs.existsSync(finalOutputPath)) {
          await unlinkAsync(finalOutputPath);
        }
        if (tempMuxedPath && fs.existsSync(tempMuxedPath)) {
          await unlinkAsync(tempMuxedPath);
        }
        const partFilePath = finalOutputPath + ".part";
        if (fs.existsSync(partFilePath)) {
          await unlinkAsync(partFilePath);
        }
        console.log("Temporary file cleanup finished.");
      } catch (cleanupErr) {
        console.error("Cleanup error:", cleanupErr);
      }
    });
    return;
  } catch (error) {
    console.error("Error processing video section:", error);
    res.status(500).json({
      error: "Failed to process video section",
      details: error instanceof Error ? error.message : "Unknown error"
    });
  }
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});