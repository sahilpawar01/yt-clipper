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
    
    // Input validation
    if (!url || !startTime || !endTime) {
      return res.status(400).json({ error: "url, startTime, and endTime are required" });
    }

    if (!isValidYouTubeUrl(url)) {
      return res.status(400).json({ error: "Invalid YouTube URL" });
    }

    // Download video segment with yt-dlp
    const runYtDlpDownload = (outputPathBase, startTime, endTime) => {
      return new Promise((resolve, reject) => {
        const outputPathTemplate = outputPathBase + ".%(ext)s";
        let detectedPath = null;
        let stderrBuffer = '';
        const section = `*${startTime}-${endTime}`;
        
        const ytDlp = spawn("python", [
          "-m", "yt_dlp",
          url,
          "-f",
          "bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/best[ext=mp4][height<=1080]/best",
          "--download-sections",
          section,
          "-o",
          outputPathTemplate,
          "--no-check-certificates",
          "--no-warnings",
          "--merge-output-format",
          "mp4",
          "--user-agent",
          getRandomUserAgent(),
          "--socket-timeout",
          "30",
          "--retries",
          "3",
          "--fragment-retries",
          "3",
          "--extractor-retries",
          "3",
          "--ignore-errors",
          "--no-playlist",
          "--no-playlist-reverse",
          "--cookies-from-browser",
          "chrome",
          "--geo-bypass",
          "--no-check-certificate",
          "--prefer-insecure",
          "--extractor-args",
          "youtube:player_client=android",
          "--force-ipv4"
        ]);

        ytDlp.stdout.on("data", (data) => {
          const output = data.toString();
          const destinationMatch = output.match(/\[download\] Destination: (.+)/);
          if (destinationMatch && destinationMatch[1]) {
            const filePath = destinationMatch[1].trim();
            if (filePath.startsWith(outputPathBase)) {
              detectedPath = filePath;
            }
          }
        });

        ytDlp.stderr.on("data", (data) => {
          stderrBuffer += data.toString();
        });

        ytDlp.on("close", (code) => {
          if (code === 0) {
            if (detectedPath && fs.existsSync(detectedPath)) {
              resolve(detectedPath);
              return;
            }
            // Fallback: search for file
            const files = fs.readdirSync(uploadsDir);
            const foundFile = files.find(f => f.startsWith(path.basename(outputPathBase)));
            if (foundFile) {
              const fullPath = path.join(uploadsDir, foundFile);
              if (fs.existsSync(fullPath)) {
                resolve(fullPath);
                return;
              }
            }
            console.error("yt-dlp succeeded but no output file found. Stderr:", stderrBuffer);
            reject(new Error("yt-dlp succeeded but no output file found."));
          } else {
            // Enhanced error handling
            let errorMessage = "Failed to download video";
            if (stderrBuffer.includes("This content isn't available")) {
              errorMessage = "This video is not available. It might be private, age-restricted, or region-locked.";
            } else if (stderrBuffer.includes("Video unavailable")) {
              errorMessage = "This video is unavailable. It might have been removed or made private.";
            } else if (stderrBuffer.includes("Sign in to confirm your age")) {
              errorMessage = "This video is age-restricted and cannot be downloaded.";
            }
            console.error("yt-dlp failed with code", code, "Stderr:", stderrBuffer);
            reject(new Error(errorMessage));
          }
        });

        ytDlp.on("error", (err) => {
          reject(new Error("Failed to start yt-dlp: " + err.message));
        });
      });
    };

    // Download segment with retry logic
    try {
      tempMuxedPath = await retry(() => runYtDlpDownload(tempMuxedPathBase, startTime, endTime));
    } catch (downloadError) {
      console.error("Failed to download after retries:", downloadError);
      return res.status(400).json({
        error: downloadError.message || "Failed to download video after multiple attempts. Please try again later."
      });
    }

    if (!tempMuxedPath) {
      return res.status(500).json({
        error: "Failed to process video: No output file was created"
      });
    }

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

    await new Promise((resolve, reject) => {
      ffmpeg.on("close", (code) => {
        if (code === 0) {
          if (fs.existsSync(finalOutputPath) && fs.statSync(finalOutputPath).size > 0) {
            resolve();
          } else {
            reject(new Error("FFmpeg output file missing or empty."));
          }
        } else {
          reject(new Error("FFmpeg failed with code " + code));
        }
      });
      ffmpeg.on("error", (err) => {
        reject(new Error("Failed to start ffmpeg: " + err.message));
      });
    });

    // Send the final clipped video file as a download
    const stream = fs.createReadStream(finalOutputPath);
    res.setHeader('Content-Disposition', 'attachment; filename="clip.mp4"');
    res.setHeader('Content-Type', 'video/mp4');
    stream.pipe(res);

    stream.on('close', async () => {
      // Cleanup
      try {
        if (fs.existsSync(finalOutputPath)) await unlinkAsync(finalOutputPath);
        if (tempMuxedPath && fs.existsSync(tempMuxedPath)) await unlinkAsync(tempMuxedPath);
        console.log("Cleanup done.");
      } catch (cleanupErr) {
        console.error("Cleanup error:", cleanupErr);
      }
    });
    return;
  } catch (error) {
    console.error("Error processing video section:", error);
    res.status(500).json({
      error: "Failed to process video section",
      details: error && error.stack ? error.stack : (error instanceof Error ? error.message : "Unknown error"),
    });
  }
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});