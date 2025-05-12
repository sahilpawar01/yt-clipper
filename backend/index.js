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
    if (!url || !startTime || !endTime) {
      return res.status(400).json({ error: "url, startTime, and endTime are required" });
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

        const ytDlp = spawn("yt-dlp", [
          url,
          "-f",
          "bestvideo[protocol=https][ext=mp4]+bestaudio[protocol=https][ext=m4a]/bestvideo[protocol=https][ext=webm]+bestaudio[protocol=https][ext=webm]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo[ext=webm]+bestaudio[ext=webm]/best",
          "--download-sections",
          section,
          "-o",
          outputPathTemplate,
          "--no-check-certificates",
          "--no-warnings",
          "--add-header",
          "referer:youtube.com",
          "--add-header",
          "user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "--merge-output-format",
          "mp4",
          "--verbose"
        ]);

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
            console.error(`yt-dlp process (muxed) exited with code ${code}. Stderr: ${processStderr}`);
            reject(new Error(`yt-dlp download (muxed) failed with code ${code}. Stderr: ${processStderr}`));
          }
        });

        ytDlp.on("error", (err) => {
          console.error(`Failed to start yt-dlp process (muxed):`, err);
          reject(new Error(`Failed to start yt-dlp (muxed): ${err.message}`));
        });
      });
    };

    // Download segment
    try {
      tempMuxedPath = await runYtDlpDownload(tempMuxedPathBase, startTime, endTime);
    } catch (downloadError) {
      console.error("yt-dlp muxed download failed.", downloadError);
      return res.status(400).json({
        error: downloadError.message || "Failed to download video. The video might be unavailable or restricted."
      });
    }

    if (!tempMuxedPath) {
      return res.status(500).json({
        error: "Failed to process video: No output file was created"
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