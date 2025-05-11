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
          "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best",
          "--download-sections",
          section,
          "-o",
          outputPathTemplate,
          "--no-check-certificates",
          "--no-warnings",
          "--merge-output-format",
          "mp4"
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
            console.error("yt-dlp failed with code", code, "Stderr:", stderrBuffer);
            reject(new Error("yt-dlp failed with code " + code + ". Stderr: " + stderrBuffer));
          }
        });

        ytDlp.on("error", (err) => {
          reject(new Error("Failed to start yt-dlp: " + err.message));
        });
      });
    };

    // Download segment
    try {
      tempMuxedPath = await runYtDlpDownload(tempMuxedPathBase, startTime, endTime);
    } catch (downloadError) {
      throw downloadError;
    }

    if (!tempMuxedPath) throw new Error("Missing temporary muxed path after download.");

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