// Autofill YouTube URL if on a YouTube tab
chrome.tabs && chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
    const tab = tabs[0];
    if (tab && tab.url && tab.url.includes("youtube.com/watch")) {
        document.getElementById('url').value = tab.url;
    }
});

document.getElementById('clipBtn').addEventListener('click', async () => {
    const url = document.getElementById('url').value.trim();
    const startTime = document.getElementById('start').value.trim();
    const endTime = document.getElementById('end').value.trim();
    const status = document.getElementById('status');
    status.style.color = "#fbbf24";
    status.textContent = "Processing...";

    if (!url || !startTime || !endTime) {
        status.style.color = "#ef4444";
        status.textContent = "Please fill in all fields.";
        return;
    }

    try {
        console.log('Sending request to backend:', { url, startTime, endTime });
        const response = await fetch('http://localhost:3001/api/clip', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, startTime, endTime })
        });

        if (!response.ok) {
            let err = "Failed to clip video.";
            try {
                const data = await response.json();
                err = data.error || err;
                console.error('Backend error:', data);
            } catch (e) {
                console.error('Error parsing error response:', e);
            }
            status.style.color = "#ef4444";
            status.textContent = "Error: " + err;
            return;
        }

        // Download the file
        const blob = await response.blob();
        if (blob.size === 0) {
            throw new Error('Received empty file from server');
        }
        const downloadUrl = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = downloadUrl;
        a.download = 'clip.mp4';
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(downloadUrl);
        status.style.color = "#22c55e";
        status.textContent = "Download started!";
    } catch (e) {
        console.error('Error during video clipping:', e);
        status.style.color = "#ef4444";
        status.textContent = "Error: " + (e.message || "Failed to process video");
    }
});