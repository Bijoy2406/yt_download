import { useEffect, useMemo, useRef, useState } from 'react';
import { Skeleton } from 'boneyard-js/react';
import DataCard from './components/DataCard.jsx';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, '') || 'http://localhost:3000';

const defaultDownloadState = {
  status: 'idle',
  formatId: null,
  label: '',
  progress: 0,
  speedText: null,
  etaText: null
};

const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

const getPreferredTheme = () => {
  const savedTheme = window.localStorage.getItem('tubevault-theme');

  if (savedTheme === 'light' || savedTheme === 'dark') {
    return savedTheme;
  }

  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};

const isValidYouTubeUrl = (value) => {
  try {
    const parsedUrl = new URL(value.trim());
    return ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(
      parsedUrl.hostname.toLowerCase()
    );
  } catch {
    return false;
  }
};

const parseJsonError = async (response) => {
  try {
    const payload = await response.json();
    return payload.error || 'Request failed.';
  } catch {
    return `Request failed with status ${response.status}.`;
  }
};

const formatCountLabel = (formats, type) => formats.filter((format) => format.type === type).length;

const previewFixtureVideo = {
  title: 'Rick Astley - Never Gonna Give You Up',
  uploader: 'Rick Astley',
  thumbnail: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
  durationLabel: '3:33',
  formats: [{ type: 'video' }, { type: 'video' }, { type: 'audio' }]
};

const videoFormatFixture = [
  {
    id: 'video-1080',
    label: '1080p MP4',
    badge: 'Video + audio',
    detail: 'Best available quality'
  },
  {
    id: 'video-720',
    label: '720p MP4',
    badge: 'Video + audio',
    detail: 'Best available quality'
  }
];

const audioFormatFixture = [
  {
    id: 'audio-mp3',
    label: 'MP3',
    badge: 'Quick download',
    detail: 'Best available source audio'
  }
];

const openExternalDownload = (downloadUrl) => {
  window.open(downloadUrl, '_blank', 'noopener,noreferrer');
};

const streamDownloadProgress = async (jobId, { signal }, onUpdate, onReady, onError) => {
  return new Promise((resolve, reject) => {
    const eventSource = new EventSource(`${API_BASE_URL}/api/download/progress/${encodeURIComponent(jobId)}/stream`);
    let timeoutId = null;

    const finish = (handler) => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      eventSource.close();
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      handler();
    };

    const onAbort = () => {
      finish(() => reject(new Error('Download cancelled by user.')));
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort);
    }

    eventSource.addEventListener('message', (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.status === 'ready') {
          onReady?.(data);
          finish(() => resolve(data));
        } else if (data.status === 'failed') {
          finish(() => reject(new Error(data.error || 'Download failed.')));
        } else {
          // Progress update
          onUpdate?.(data);
        }
      } catch (error) {
        console.error('Failed to parse progress event:', error);
      }
    });

    eventSource.addEventListener('error', (error) => {
      finish(() => reject(new Error('Connection lost. Please check your network.')));
    });

    // Timeout after 30 minutes
    timeoutId = setTimeout(() => {
      finish(() => reject(new Error('Download preparation timed out. Please try again.')));
    }, 30 * 60 * 1000);
  });
};

const buildProgressMetaLabel = ({ progress, speedText, etaText }) => {
  const safeProgress = `${Math.max(0, Math.min(100, Math.round(Number(progress) || 0)))}%`;
  const safeSpeed = speedText || '--';
  const safeEta = etaText || '--';

  return `${safeProgress} • ${safeSpeed} • ${safeEta} left`;
};

function VideoPreview({ video, onCopyTitle }) {
  const cardData = video
    ? {
        avatar: video.thumbnail || 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
        title: video.title,
        description: video.uploader,
        meta: `${video.durationLabel} • ${formatCountLabel(video.formats, 'video')} video • ${formatCountLabel(
          video.formats,
          'audio'
        )} audio`
      }
    : null;

  return (
    <article className="panel surface-panel preview-panel">
      <div className="panel-header">
        <div>
          <span className="eyebrow">Preview</span>
          <h2>Video details</h2>
        </div>
        {video && (
          <button type="button" className="ghost-button" onClick={onCopyTitle}>
            Copy title
          </button>
        )}
      </div>

      {video ? (
        <DataCard isLoading={false} data={cardData} />
      ) : (
        <div className="empty-state">
          <div className="empty-icon">01</div>
          <p>Paste a YouTube URL to load formats.</p>
        </div>
      )}
    </article>
  );
}

function FormatList({ formats, emptyText, actionText, processingText, activeFormatId, isBusy, onDownload }) {
  return (
    <div className="format-grid">
      {formats.length ? (
        formats.map((format) => (
          <button
            key={format.id}
            type="button"
            className={`format-card ${format.type === 'audio' ? 'audio-card' : ''}`}
            disabled={isBusy}
            onClick={() => onDownload(format)}
          >
            <div className="format-head">
              <span className="format-label">{format.label}</span>
              <span className="format-badge">{format.badge}</span>
            </div>
            <p>{format.detail}</p>
            <span className="format-action">
              {activeFormatId === format.id && isBusy ? processingText : actionText}
            </span>
          </button>
        ))
      ) : (
        <div className="format-empty">{emptyText}</div>
      )}
    </div>
  );
}

function App() {
  const [theme, setTheme] = useState(() => getPreferredTheme());
  const [url, setUrl] = useState('');
  const [video, setVideo] = useState(null);
  const [isFetchingInfo, setIsFetchingInfo] = useState(false);
  const [downloadState, setDownloadState] = useState(defaultDownloadState);
  const [toasts, setToasts] = useState([]);
  const downloadModalTimerRef = useRef(null);
  const abortControllerRef = useRef(null);
  const activeJobIdRef = useRef(null);

  const videoFormats = useMemo(
    () => video?.formats.filter((format) => format.type === 'video') ?? [],
    [video]
  );
  const audioFormats = useMemo(
    () => video?.formats.filter((format) => format.type === 'audio') ?? [],
    [video]
  );

  const pushToast = (message, tone = 'info') => {
    const id = crypto.randomUUID();
    setToasts((current) => [...current, { id, message, tone }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 3600);
  };

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem('tubevault-theme', theme);
  }, [theme]);

  useEffect(
    () => () => {
      window.clearTimeout(downloadModalTimerRef.current);
    },
    []
  );

  const resetDownloadState = () => {
    if (activeJobIdRef.current) {
      fetch(`${API_BASE_URL}/api/download/cancel/${activeJobIdRef.current}`, {
        method: 'DELETE'
      }).catch(console.error);
      activeJobIdRef.current = null;
    }
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    window.clearTimeout(downloadModalTimerRef.current);
    downloadModalTimerRef.current = null;
    setDownloadState(defaultDownloadState);
  };

  const handleFetchInfo = async (event) => {
    event.preventDefault();
    const trimmedUrl = url.trim();

    if (!isValidYouTubeUrl(trimmedUrl)) {
      pushToast('Paste a valid YouTube video URL first.', 'error');
      return;
    }

    setIsFetchingInfo(true);

    try {
      const response = await fetch(`${API_BASE_URL}/api/info?url=${encodeURIComponent(trimmedUrl)}`);

      if (!response.ok) {
        throw new Error(await parseJsonError(response));
      }

      const payload = await response.json();
      setVideo(payload.video);
      pushToast('Formats are ready.', 'success');
    } catch (error) {
      setVideo(null);
      pushToast(error.message || 'Could not fetch video details.', 'error');
    } finally {
      setIsFetchingInfo(false);
    }
  };

  const handleDownload = async (format) => {
    const trimmedUrl = url.trim();

    if (!trimmedUrl || !video) {
      pushToast('Load a video first before downloading.', 'error');
      return;
    }

    setDownloadState({
      status: 'preparing',
      formatId: format.id,
      label: `Preparing ${format.label}`,
      progress: 0,
      speedText: null,
      etaText: null
    });
    pushToast('Preparing download. This can take a moment.', 'info');

    try {
      const startResponse = await fetch(
        `${API_BASE_URL}/api/download/prepare?url=${encodeURIComponent(trimmedUrl)}&format=${encodeURIComponent(format.id)}`,
        {
          method: 'POST'
        }
      );

      if (!startResponse.ok) {
        throw new Error(await parseJsonError(startResponse));
      }

      const startPayload = await startResponse.json();
      activeJobIdRef.current = startPayload.jobId;

      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      await streamDownloadProgress(
        startPayload.jobId,
        { signal: abortController.signal },
        (progressData) => {
          // Real-time progress update
          setDownloadState((current) => {
            if (current.status === 'idle' || current.status === 'transferring') {
              return current;
            }

            return {
              ...current,
              status: 'preparing',
              label: current.label,
              progress: Math.max(0, Math.min(100, Number(progressData.progress) || 0)),
              speedText: progressData.speedText || null,
              etaText: progressData.etaText || null
            };
          });
        },
        (readyData) => {
          // Download ready
          const resolvedDownloadUrl = String(readyData.downloadUrl || '').startsWith('http')
            ? readyData.downloadUrl
            : `${API_BASE_URL}${readyData.downloadUrl}`;

          setDownloadState((current) => ({
            ...current,
            status: 'transferring',
            label: 'Sending to browser / IDM…',
            progress: 100,
            speedText: null,
            etaText: null
          }));

          openExternalDownload(resolvedDownloadUrl);
          pushToast('File is ready — your browser or IDM is now downloading it.', 'success');
        }
      );
    } catch (error) {
      if (error.message === 'Download cancelled by user.') {
        // Suppress toast for user cancellation
        return;
      }
      setDownloadState(defaultDownloadState);
      pushToast(error.message || 'Could not prepare the download.', 'error');
    }
  };

  const handleCopyTitle = async () => {
    if (!video?.title) {
      return;
    }

    try {
      await navigator.clipboard.writeText(video.title);
      pushToast('Video title copied.', 'success');
    } catch {
      pushToast('Clipboard access was blocked.', 'error');
    }
  };

  const quickAudioFormat = video?.formats.find(
    (format) => format.id === video?.quickActions?.audioOnlyFormatId
  );

  return (
    <div className="page-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />

      <main className="app-frame">
        <section className="hero-card">
          <div className="hero-topline">
            <span className="eyebrow">TubeVault</span>
            <button
              type="button"
              className="theme-toggle"
              onClick={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
            >
              {theme === 'dark' ? 'Light mode' : 'Dark mode'}
            </button>
          </div>

          <div className="hero-content">
            <div>
              <h1>YouTube downloader</h1>
              <p>Paste link. Pick format. Download.</p>
            </div>
          </div>

          <form className="url-form" onSubmit={handleFetchInfo}>
            <label className="input-shell">
              <span>YouTube URL</span>
              <input
                type="url"
                inputMode="url"
                placeholder="https://www.youtube.com/watch?v=..."
                value={url}
                onChange={(event) => setUrl(event.target.value)}
              />
            </label>

            <div className="hero-actions">
              <button type="submit" className="primary-button" disabled={isFetchingInfo}>
                {isFetchingInfo ? 'Fetching details...' : 'Fetch video info'}
              </button>

              <button
                type="button"
                className="secondary-button"
                disabled={!quickAudioFormat || downloadState.status !== 'idle'}
                onClick={() => quickAudioFormat && handleDownload(quickAudioFormat)}
              >
                Download audio only
              </button>
            </div>
          </form>
        </section>

        <section className="info-grid">
          <Skeleton
            name="video-preview"
            loading={isFetchingInfo}
            animate="shimmer"
            transition
            fixture={<VideoPreview video={previewFixtureVideo} onCopyTitle={() => {}} />}
          >
            <VideoPreview video={video} onCopyTitle={handleCopyTitle} />
          </Skeleton>
        </section>

        <section className="formats-layout">
          <article className="panel surface-panel">
            <div className="panel-header">
              <div>
                <span className="eyebrow">Downloads</span>
                <h2>MP4 video formats</h2>
              </div>
            </div>

            <Skeleton
              name="video-formats"
              loading={isFetchingInfo}
              animate="shimmer"
              transition
              fixture={
                <FormatList
                  formats={videoFormatFixture}
                  emptyText="Load a video to see MP4 options."
                  actionText="Download now"
                  processingText="Processing..."
                  activeFormatId={null}
                  isBusy={false}
                  onDownload={() => {}}
                />
              }
            >
              <FormatList
                formats={videoFormats}
                emptyText="Load a video to see MP4 options."
                actionText="Download now"
                processingText="Processing..."
                activeFormatId={downloadState.formatId}
                isBusy={downloadState.status !== 'idle'}
                onDownload={handleDownload}
              />
            </Skeleton>
          </article>

          <article className="panel surface-panel">
            <div className="panel-header">
              <div>
                <span className="eyebrow">Audio</span>
                <h2>MP3 audio formats</h2>
              </div>
            </div>

            <div className="single-column">
              <Skeleton
                name="audio-formats"
                loading={isFetchingInfo}
                animate="shimmer"
                transition
                fixture={
                  <FormatList
                    formats={audioFormatFixture}
                    emptyText="Load a video to see MP3 option."
                    actionText="Download audio"
                    processingText="Processing..."
                    activeFormatId={null}
                    isBusy={false}
                    onDownload={() => {}}
                  />
                }
              >
                <FormatList
                  formats={audioFormats}
                  emptyText="Load a video to see MP3 option."
                  actionText="Download audio"
                  processingText="Processing..."
                  activeFormatId={downloadState.formatId}
                  isBusy={downloadState.status !== 'idle'}
                  onDownload={handleDownload}
                />
              </Skeleton>
            </div>
          </article>
        </section>
      </main>

      {downloadState.status !== 'idle' && (
        <div className="download-modal-backdrop" role="dialog" aria-modal="true" aria-label="Download progress">
          <div className={`download-modal ${downloadState.status === 'transferring' ? 'is-ready' : ''}`}>
            
            <div className="modal-glow-bg"></div>

            <div className="download-modal-header">
              <div className="header-info">
                <span className="eyebrow glow-text">Active Task</span>
                <h2 className="title-pulse">{downloadState.label}</h2>
              </div>
              <span className={`download-status-pill status-${downloadState.status}`}>
                {downloadState.status === 'preparing' ? <span className="dot-pulse"></span> : null}
                {downloadState.status}
              </span>
            </div>

            <div className="download-progress-container">
              <div className="download-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={downloadState.progress}>
                <div className="download-progress-bar" style={{ width: `${downloadState.progress}%` }}>
                  <div className="progress-glow"></div>
                </div>
              </div>
              <div className="progress-metrics">
                <span className="metric-pct">{downloadState.progress}%</span>
                {downloadState.status !== 'transferring' && (
                  <span className="metric-details">
                    <span className="speed">{downloadState.speedText || 'Calculating'}</span>
                    <span className="separator">•</span>
                    <span className="eta">{downloadState.etaText || '--:--'}</span>
                  </span>
                )}
              </div>
            </div>

            <div className="download-modal-footer">
              <div className="status-message">
                {downloadState.status === 'transferring'
                  ? 'Ready! Check your browser downloads.'
                  : 'Your browser or IDM will capture this automatically.'}
              </div>
              <button
                type="button"
                className="cancel-btn"
                onClick={resetDownloadState}
              >
                {downloadState.status === 'transferring' ? 'Dismiss' : 'Cancel Process'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="toast-stack" aria-live="polite" aria-atomic="true">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.tone}`}>
            {toast.message}
          </div>
        ))}
      </div>
    </div>
  );
}

export default App;
