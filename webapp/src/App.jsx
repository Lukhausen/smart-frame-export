//FILE: App.jsx

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Upload, Button, Space, message, Typography, Layout, Tooltip, InputNumber } from 'antd'; // Added InputNumber
import {
  InboxOutlined,
  PlayCircleOutlined,
  PauseCircleOutlined,
  DownloadOutlined,
  LeftOutlined,
  RightOutlined,
  CaretUpOutlined,
  StarOutlined, 
  EyeOutlined,  
} from '@ant-design/icons';
import './App.css';

const { Title, Paragraph } = Typography;
const { Header, Content, Footer } = Layout;

// --- Constants ---
const DEFAULT_FRAME_RATE = 30;
const TIME_EPSILON = 0.001;
const FRAME_TIME_OFFSET_FACTOR = 0.01;
// const PRIORITY_ANALYSIS_RADIUS = 10; // Replaced by localViewRadius state
const SEEK_TIMEOUT_MS = 3500;
const USER_INTERACTION_SETTLE_DELAY = 500;
const NUM_WORKERS = 3;
const GLOBAL_HEATMAP_HEIGHT = 20;

// --- Analysis Task Controller ---
let analysisTaskController = {
  isGloballyCancelled: false, isRecursiveAnalysisPaused: false,
  isSeekingVideoLocked: false, recursiveQueue: [], priorityQueue: [], analyzedScores: new Map(),
  globalMinScore: Infinity, globalMaxScore: -Infinity,
  nextScheduledAnalysisId: null, currentSeekPromise: null,
  currentFocusedCenterFrame: 0, // Tracks the logical center for analysis purposes
  activeAnalysisProcesses: 0,
};

function App() {
  // --- React State ---
  const [videoFile, setVideoFile] = useState(null);
  const [videoSrc, setVideoSrc] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [frameRate, setFrameRate] = useState(DEFAULT_FRAME_RATE);
  const [currentFrameNumber, setCurrentFrameNumber] = useState(0);
  const [totalFrames, setTotalFrames] = useState(0);
  const [heatmapVersion, setHeatmapVersion] = useState(0);
  const [overallBestFrame, setOverallBestFrame] = useState(null);
  const [isUserInteracting, setIsUserInteracting] = useState(false);
  const [focusedHeatmapData, setFocusedHeatmapData] = useState([]);
  const [showFocusedHeatmap, setShowFocusedHeatmap] = useState(false);
  const [globalHeatmapCanvasWidth, setGlobalHeatmapCanvasWidth] = useState(0);
  
  const [localViewRadius, setLocalViewRadius] = useState(10); // New state for configurable radius
  const [uiFocusedCenterFrame, setUiFocusedCenterFrame] = useState(0); // New state for UI sync of focused view center

  // --- Refs ---
  const visibleVideoRef = useRef(null);
  const analysisVideoRef = useRef(null);
  const analysisCanvasRef = useRef(null);
  const downloadCanvasRef = useRef(null);
  const globalHeatmapCanvasRef = useRef(null);
  const globalHeatmapContainerRef = useRef(null);
  const stableRefs = useRef({}).current;

  useEffect(() => { 
    Object.assign(stableRefs, { 
      frameRate, totalFrames, duration, isPlaying, overallBestFrame, 
      videoSrc, currentTime, currentFrameNumber, isUserInteracting,
      localViewRadius, // Add localViewRadius to stableRefs
      uiFocusedCenterFrame // Add uiFocusedCenterFrame to stableRefs for access in callbacks
    }); 
  }, [
    frameRate, totalFrames, duration, isPlaying, overallBestFrame, 
    videoSrc, currentTime, currentFrameNumber, isUserInteracting,
    localViewRadius, uiFocusedCenterFrame // Add dependencies
  ]);

  // --- Worker Logic ---
  const workerPool = useRef([]);
  const workerBusyStates = useRef(new Array(NUM_WORKERS).fill(false));
  const workerTaskCallbacks = useRef(new Map());
  const nextTaskId = useRef(0);
  useEffect(() => { 
    for (let i = 0; i < NUM_WORKERS; i++) {
      const worker = new Worker(new URL('./sharpness.worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = (event) => { const { id, score, error, status } = event.data; const task = workerTaskCallbacks.current.get(id); if (task) { if (status === 'success') { task.resolve(score); } else { console.error(`Worker task ${id} failed:`, error); task.reject(new Error(error || `Worker task ${id} failed.`)); } workerTaskCallbacks.current.delete(id); if (typeof task.workerIndex === 'number' && workerBusyStates.current[task.workerIndex] !== undefined) { workerBusyStates.current[task.workerIndex] = false; } } };
      worker.onerror = (err) => { console.error(`Worker ${i} instance error:`, err.message, err); if(workerBusyStates.current[i] !== undefined) workerBusyStates.current[i] = false; workerTaskCallbacks.current.forEach((taskCb, taskId) => { if (taskCb.workerIndex === i) { taskCb.reject(new Error(`Worker ${i} critically failed: ${err.message}`)); workerTaskCallbacks.current.delete(taskId); } }); };
      workerPool.current.push(worker);
    } workerBusyStates.current = new Array(NUM_WORKERS).fill(false);
    return () => { workerPool.current.forEach(w => w.terminate()); workerPool.current = []; workerTaskCallbacks.current.forEach(t => t.reject(new Error("Unmounting"))); workerTaskCallbacks.current.clear(); workerBusyStates.current.fill(false); };
  }, []);
  const dispatchToWorker = useCallback(async (imageData, frameNumberToAnalyze) => { 
    if (analysisTaskController.isGloballyCancelled) throw new Error("Global cancel"); let attempts = 0; const maxAttempts = 200; let workerIndex = -1;
    while(workerIndex === -1 && attempts < maxAttempts) { workerIndex = workerBusyStates.current.findIndex(busy => !busy); if (workerIndex === -1) { if (analysisTaskController.isGloballyCancelled) throw new Error("Global cancel while waiting worker"); await new Promise(r => setTimeout(r, 50 + Math.random() * 20)); attempts++; } }
    if (workerIndex === -1) throw new Error(`No worker for F${frameNumberToAnalyze}`); workerBusyStates.current[workerIndex] = true; const worker = workerPool.current[workerIndex]; const taskId = `task-${frameNumberToAnalyze}-${nextTaskId.current++}`;
    return new Promise((resolve, reject) => { workerTaskCallbacks.current.set(taskId, { resolve, reject, workerIndex }); try { worker.postMessage({ id: taskId, imageDataBuffer: imageData.data.buffer, width: imageData.width, height: imageData.height, }, [imageData.data.buffer]); } catch (e) { console.error(`Post msg err F${frameNumberToAnalyze}:`, e); if(workerBusyStates.current[workerIndex]!==undefined) workerBusyStates.current[workerIndex] = false; workerTaskCallbacks.current.delete(taskId); reject(e); } });
  }, []);


  // --- Utility Functions ---
  const timeToFrame = useCallback((time) => { 
    if (stableRefs.duration === 0 || stableRefs.frameRate === 0 || stableRefs.totalFrames === 0) return 0;
    return Math.min(stableRefs.totalFrames, Math.max(1, Math.floor(time * stableRefs.frameRate) + 1));
   }, [stableRefs]);
  const frameToTime = useCallback((frame) => { 
    if (stableRefs.frameRate === 0 || frame <= 0) return 0;
    const frameDuration = 1 / stableRefs.frameRate;
    return Math.max(0, (frame - 1) / stableRefs.frameRate + (frameDuration * FRAME_TIME_OFFSET_FACTOR));
  }, [stableRefs]);

  // --- Core Effects ---
  useEffect(() => { 
    return () => { if (videoSrc) URL.revokeObjectURL(videoSrc); if (analysisTaskController.nextScheduledAnalysisId) cancelAnimationFrame(analysisTaskController.nextScheduledAnalysisId); analysisTaskController.isGloballyCancelled = true; analysisTaskController.currentSeekPromise = null; analysisTaskController.activeAnalysisProcesses = 0; workerTaskCallbacks.current.forEach(cb => cb.reject(new Error("Video changed/unmount"))); workerTaskCallbacks.current.clear(); };
   }, [videoSrc]);
  useEffect(() => { 
    if (duration > 0 && frameRate > 0) { const newTotalFrames = Math.floor(duration * frameRate); setTotalFrames(newTotalFrames); setCurrentFrameNumber(timeToFrame(currentTime)); } else { setTotalFrames(0); setCurrentFrameNumber(0); }
   }, [duration, frameRate, currentTime, timeToFrame]);

  // --- Seek Video Element ---
  const seekVideoElement = useCallback(async (videoElement, timeToSeek, isAnalysisSeek = false) => { 
    if (analysisTaskController.isGloballyCancelled && isAnalysisSeek) return; if (!videoElement || stableRefs.duration === 0 || videoElement.readyState < 1) { return; } const currentSeekLockHolder = isAnalysisSeek ? 'analysis' : 'user';
    if (analysisTaskController.isSeekingVideoLocked && analysisTaskController.currentSeekerType !== currentSeekLockHolder) { if (analysisTaskController.currentSeekPromise) { try { await analysisTaskController.currentSeekPromise; } catch (e) {/* ignore */} } }
    if (analysisTaskController.isGloballyCancelled && isAnalysisSeek) return; analysisTaskController.isSeekingVideoLocked = true; analysisTaskController.currentSeekerType = currentSeekLockHolder; const fr = stableRefs.frameRate || DEFAULT_FRAME_RATE; const targetTime = Math.max(0, Math.min(timeToSeek, stableRefs.duration - (1 / fr) * 0.1));
    if (Math.abs(videoElement.currentTime - targetTime) < TIME_EPSILON / 2 && videoElement.readyState >= 3) { if (videoElement === visibleVideoRef.current && Math.abs(stableRefs.currentTime - videoElement.currentTime) > TIME_EPSILON) setCurrentTime(videoElement.currentTime); analysisTaskController.isSeekingVideoLocked = false; analysisTaskController.currentSeekPromise = null; analysisTaskController.currentSeekerType = null; return; }
    const seekPromise = new Promise((resolve, reject) => { let done = false; const clean = () => { videoElement.removeEventListener('seeked', onS); videoElement.removeEventListener('error', onE); clearTimeout(sT); analysisTaskController.isSeekingVideoLocked = false; if(analysisTaskController.currentSeekPromise === seekPromise) { analysisTaskController.currentSeekPromise = null; analysisTaskController.currentSeekerType = null; }}; const onS = () => { if(done)return; done=true; if(videoElement === visibleVideoRef.current) setCurrentTime(videoElement.currentTime); clean(); resolve(); }; const onE = (e) => { if(done)return; done=true; console.error("Seek error:", e); if(videoElement === visibleVideoRef.current) setCurrentTime(videoElement.currentTime); clean(); reject(e); }; const sT = setTimeout(() => { if(done)return; onE(new Error(`Seek to ${targetTime.toFixed(3)} timed out`)); }, SEEK_TIMEOUT_MS); videoElement.addEventListener('seeked', onS); videoElement.addEventListener('error', onE); videoElement.currentTime = targetTime; });
    analysisTaskController.currentSeekPromise = seekPromise; try { await seekPromise; } catch (e) {/* ignore */ }
   }, [setCurrentTime, stableRefs]);

  // --- Analyze Single Frame ---
  const analyzeSingleFrame = useCallback(async (frameNumberToAnalyze, isPriorityTask = false) => {
    if (analysisTaskController.isGloballyCancelled || !analysisVideoRef.current || frameNumberToAnalyze <= 0 || frameNumberToAnalyze > stableRefs.totalFrames) return null;
    
    const isFrameInCurrentFocus = stableRefs.uiFocusedCenterFrame > 0 && Math.abs(frameNumberToAnalyze - stableRefs.uiFocusedCenterFrame) <= stableRefs.localViewRadius;

    if (analysisTaskController.analyzedScores.has(frameNumberToAnalyze) && !analysisTaskController.analyzedScores.get(frameNumberToAnalyze)?.error) {
      const existingData = analysisTaskController.analyzedScores.get(frameNumberToAnalyze);
      if (isPriorityTask && isFrameInCurrentFocus) {
        setFocusedHeatmapData(p => {
          const i = p.findIndex(d => d.frame === frameNumberToAnalyze);
          if (i > -1 && (!p[i].score || p[i].score !== existingData.score || p[i].needsAnalysis)) {
            const u = [...p];
            u[i] = { ...u[i], score: existingData.score, time: existingData.time, error: false, needsAnalysis: false };
            return u;
          }
          return p;
        });
      }
      return existingData;
    }
    
    const time = frameToTime(frameNumberToAnalyze);
    let scoreData = null;
    try {
      await seekVideoElement(analysisVideoRef.current, time, true);
      if (analysisTaskController.isGloballyCancelled) return null;
      const actualTimeAfterSeek = analysisVideoRef.current.currentTime;
      if (!analysisCanvasRef.current) analysisCanvasRef.current = document.createElement('canvas');
      if (analysisVideoRef.current.readyState < 2) { await new Promise(r => setTimeout(r, 50)); if (analysisVideoRef.current.readyState < 2 || analysisTaskController.isGloballyCancelled) return null; }
      if (analysisVideoRef.current.videoWidth === 0 || analysisVideoRef.current.videoHeight === 0) { throw new Error("Video dimensions zero"); }
      const canvas = analysisCanvasRef.current;
      const videoElement = analysisVideoRef.current;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const analysisWidth = 160;
      const aspectRatio = videoElement.videoWidth / videoElement.videoHeight;
      const analysisHeight = Math.max(1, Math.floor(aspectRatio > 0 ? analysisWidth / aspectRatio : analysisWidth * (9/16) ));
      canvas.width = analysisWidth; canvas.height = analysisHeight;
      ctx.drawImage(videoElement, 0, 0, analysisWidth, analysisHeight);
      const imageData = ctx.getImageData(0, 0, analysisWidth, analysisHeight);
      const score = await dispatchToWorker(imageData, frameNumberToAnalyze);
      
      scoreData = { score, time: actualTimeAfterSeek, frame: frameNumberToAnalyze, error: false };
      analysisTaskController.analyzedScores.set(frameNumberToAnalyze, scoreData);
      analysisTaskController.globalMinScore = Math.min(analysisTaskController.globalMinScore, score);
      analysisTaskController.globalMaxScore = Math.max(analysisTaskController.globalMaxScore, score);

      const currentOverallBest = stableRefs.overallBestFrame;
      if (!scoreData.error && (
          !currentOverallBest ||
          (currentOverallBest.error) || 
          (scoreData.score > currentOverallBest.score)
      )) {
          setOverallBestFrame(scoreData);
      }

      if (isPriorityTask && isFrameInCurrentFocus) {
        setFocusedHeatmapData(p => {
          const i = p.findIndex(d => d.frame === frameNumberToAnalyze);
          if (i > -1) {
            const u = [...p];
            u[i] = { ...u[i], score: score, time: actualTimeAfterSeek, error: false, needsAnalysis: false };
            return u;
          }
          return p;
        });
      }
    } catch (error) {
      console.error(`Err F${frameNumberToAnalyze}:`, error.message);
      scoreData = { score: 0, time, frame: frameNumberToAnalyze, error: true }; // Ensure score is defined for error cases
      analysisTaskController.analyzedScores.set(frameNumberToAnalyze, scoreData);
      if (isPriorityTask && isFrameInCurrentFocus) {
        setFocusedHeatmapData(p => {
          const i = p.findIndex(d => d.frame === frameNumberToAnalyze);
          if (i > -1) {
            const u = [...p];
            u[i] = { ...u[i], score: null, error: true, needsAnalysis: false };
            return u;
          }
          return p;
        });
      }
    }
    return scoreData;
  }, [seekVideoElement, frameToTime, dispatchToWorker, stableRefs]);

  // --- Analysis Scheduling Logic ---
  const scheduleNextAnalysis = useCallback(() => { 
    if (analysisTaskController.isGloballyCancelled) return; if (analysisTaskController.nextScheduledAnalysisId) cancelAnimationFrame(analysisTaskController.nextScheduledAnalysisId);
    analysisTaskController.nextScheduledAnalysisId = requestAnimationFrame(() => { if (analysisTaskController.isGloballyCancelled || (analysisTaskController.isSeekingVideoLocked && analysisTaskController.currentSeekerType !== 'analysis')) { if (!analysisTaskController.isGloballyCancelled) scheduleNextAnalysis(); return; } const currentUserInteracting = stableRefs.isUserInteracting; if (currentUserInteracting && analysisTaskController.priorityQueue.length === 0) { analysisTaskController.isRecursiveAnalysisPaused = true; if (!analysisTaskController.isGloballyCancelled) scheduleNextAnalysis(); return; } else if (!currentUserInteracting) { analysisTaskController.isRecursiveAnalysisPaused = false; } let tasksLaunchedThisCycle = 0;
      while (analysisTaskController.activeAnalysisProcesses < NUM_WORKERS && (analysisTaskController.priorityQueue.length > 0 || (!analysisTaskController.isRecursiveAnalysisPaused && analysisTaskController.recursiveQueue.length > 0))) { let frameToAnalyze = null; let isPriority = false; let segmentForRecursiveSplit = null; if (analysisTaskController.priorityQueue.length > 0) { frameToAnalyze = analysisTaskController.priorityQueue.shift(); isPriority = true; } else if (!analysisTaskController.isRecursiveAnalysisPaused && analysisTaskController.recursiveQueue.length > 0) { analysisTaskController.recursiveQueue.sort((a,b)=>a.depth-b.depth||(a.endFrame-a.startFrame)-(b.endFrame-b.startFrame)); const segment = analysisTaskController.recursiveQueue.shift(); if (segment && segment.startFrame <= segment.endFrame) { frameToAnalyze = Math.floor((segment.startFrame + segment.endFrame) / 2); segmentForRecursiveSplit = segment; } else { continue; } } else { break; }
        if (frameToAnalyze && (!analysisTaskController.analyzedScores.has(frameToAnalyze) || analysisTaskController.analyzedScores.get(frameToAnalyze)?.error)) { analysisTaskController.activeAnalysisProcesses++; tasksLaunchedThisCycle++; if (segmentForRecursiveSplit && frameToAnalyze !== null) { if (frameToAnalyze - 1 >= segmentForRecursiveSplit.startFrame) analysisTaskController.recursiveQueue.push({startFrame:segmentForRecursiveSplit.startFrame,endFrame:frameToAnalyze-1,depth:segmentForRecursiveSplit.depth+1}); if (frameToAnalyze + 1 <= segmentForRecursiveSplit.endFrame) analysisTaskController.recursiveQueue.push({startFrame:frameToAnalyze+1,endFrame:segmentForRecursiveSplit.endFrame,depth:segmentForRecursiveSplit.depth+1}); } analyzeSingleFrame(frameToAnalyze, isPriority).catch(e => console.error(`Unhandled F${frameToAnalyze}:`, e)).finally(() => { analysisTaskController.activeAnalysisProcesses--; setHeatmapVersion(v => v + 1); if (!analysisTaskController.isGloballyCancelled) scheduleNextAnalysis(); });
        } else if (frameToAnalyze && segmentForRecursiveSplit) { if (frameToAnalyze - 1 >= segmentForRecursiveSplit.startFrame) analysisTaskController.recursiveQueue.push({startFrame:segmentForRecursiveSplit.startFrame,endFrame:frameToAnalyze-1,depth:segmentForRecursiveSplit.depth+1}); if (frameToAnalyze + 1 <= segmentForRecursiveSplit.endFrame) analysisTaskController.recursiveQueue.push({startFrame:frameToAnalyze+1,endFrame:segmentForRecursiveSplit.endFrame,depth:segmentForRecursiveSplit.depth+1}); } }
      if (stableRefs.isPlaying && analysisTaskController.activeAnalysisProcesses === 0 && analysisTaskController.priorityQueue.length === 0 && analysisTaskController.recursiveQueue.length > 0 ) { analysisTaskController.nextScheduledAnalysisId = setTimeout(scheduleNextAnalysis, 300 + Math.random()*150); return; }
      if (!analysisTaskController.isGloballyCancelled && tasksLaunchedThisCycle === 0 && (analysisTaskController.priorityQueue.length > 0 || analysisTaskController.recursiveQueue.length > 0 || analysisTaskController.activeAnalysisProcesses > 0)) { scheduleNextAnalysis(); } else if (tasksLaunchedThisCycle > 0) { /* .finally will call */ } else if (analysisTaskController.activeAnalysisProcesses === 0 && analysisTaskController.priorityQueue.length === 0 && analysisTaskController.recursiveQueue.length === 0) { /* All done */ } else { if (!analysisTaskController.isGloballyCancelled) scheduleNextAnalysis(); } });
  }, [analyzeSingleFrame, stableRefs]);

  // --- Main Analysis Lifecycle Effect ---
  useEffect(() => { 
    if (videoSrc && totalFrames > 0 && duration > 0) { 
      if (analysisTaskController.nextScheduledAnalysisId) cancelAnimationFrame(analysisTaskController.nextScheduledAnalysisId); 
      analysisTaskController.isGloballyCancelled = false; 
      analysisTaskController.isRecursiveAnalysisPaused = false; 
      analysisTaskController.isSeekingVideoLocked = false; 
      analysisTaskController.currentSeekPromise = null; 
      analysisTaskController.currentSeekerType = null; 
      analysisTaskController.recursiveQueue = [{ startFrame: 1, endFrame: totalFrames, depth: 0 }]; 
      analysisTaskController.priorityQueue = []; 
      analysisTaskController.analyzedScores.clear(); 
      analysisTaskController.globalMinScore = Infinity; 
      analysisTaskController.globalMaxScore = -Infinity; 
      analysisTaskController.currentFocusedCenterFrame = 0; 
      setUiFocusedCenterFrame(0); // Reset UI focused center frame
      analysisTaskController.activeAnalysisProcesses = 0; 
      workerTaskCallbacks.current.forEach(t => t.reject(new Error("New video"))); 
      workerTaskCallbacks.current.clear(); 
      workerBusyStates.current.fill(false); 
      setOverallBestFrame(null); 
      setFocusedHeatmapData([]); 
      setShowFocusedHeatmap(false); 
      setHeatmapVersion(v => v + 1); 
      scheduleNextAnalysis(); 
    }
    return () => { if (analysisTaskController.nextScheduledAnalysisId) cancelAnimationFrame(analysisTaskController.nextScheduledAnalysisId); analysisTaskController.isGloballyCancelled = true; analysisTaskController.activeAnalysisProcesses = 0; };
  }, [videoSrc, totalFrames, duration, scheduleNextAnalysis]);

  // --- Focused Heatmap Data Generation (with Local Best) ---
  useEffect(() => {
    if (showFocusedHeatmap && uiFocusedCenterFrame > 0 && stableRefs.totalFrames > 0) {
      const center = uiFocusedCenterFrame;
      const radius = localViewRadius; // Use state here
      const currentFocusData = [];
      for (let i = -radius; i <= radius; i++) {
        const frame = center + i;
        if (frame >= 1 && frame <= stableRefs.totalFrames) {
          const sD = analysisTaskController.analyzedScores.get(frame);
          currentFocusData.push({ 
            frame, 
            score: sD ? sD.score : null, 
            time: sD ? sD.time : null, 
            isCenter: frame === center, 
            error: sD ? !!sD.error : false,
            needsAnalysis: !sD || (sD && !!sD.error) // if no score data, or if there is an error, it needs analysis (or re-analysis if desired)
          });
        }
      }
      let localBestScore = -Infinity; 
      let localBestFrameData = null; 
      currentFocusData.forEach(item => { 
        if (item.score !== null && !item.error && item.score > localBestScore) { 
          localBestScore = item.score; 
          localBestFrameData = item; 
        } 
      });
      const scoresInFocus = currentFocusData.filter(d => d.score !== null && !d.error).map(d => d.score);
      const minL = scoresInFocus.length > 0 ? Math.min(...scoresInFocus) : 0; 
      const maxL = scoresInFocus.length > 0 ? Math.max(...scoresInFocus) : 0; 
      const rangeL = maxL - minL;
      
      setFocusedHeatmapData(currentFocusData.map(d => ({ 
        ...d, 
        isLocalBest: localBestFrameData !== null && d.frame === localBestFrameData.frame, // Check localBestFrameData not null
        normalizedScoreLocal: d.score === null || d.error ? 0.5 : (rangeL > TIME_EPSILON ? (d.score - minL) / rangeL : (scoresInFocus.length > 0 ? 0.5 : 0)) 
      })));
    } else if (!showFocusedHeatmap && focusedHeatmapData.length > 0) { 
        setFocusedHeatmapData([]); 
    }
  }, [showFocusedHeatmap, uiFocusedCenterFrame, localViewRadius, heatmapVersion, stableRefs.totalFrames]);


  // --- Global Heatmap Canvas Drawing Effect ---
  useEffect(() => { 
    const canvas = globalHeatmapCanvasRef.current; const container = globalHeatmapContainerRef.current; if (!canvas || !container || !videoSrc || stableRefs.totalFrames === 0) { if(canvas) { const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, canvas.width, canvas.height); } return; }
    const ctx = canvas.getContext('2d'); const canvasWidth = container.offsetWidth; if (canvasWidth <=0) return; canvas.width = canvasWidth; canvas.height = GLOBAL_HEATMAP_HEIGHT; setGlobalHeatmapCanvasWidth(canvasWidth); ctx.clearRect(0, 0, canvas.width, canvas.height);
    const { globalMinScore, globalMaxScore, analyzedScores } = analysisTaskController; const localTotalFrames = stableRefs.totalFrames; const sortedKeyframes = Array.from(analyzedScores.values()).filter(kf => kf.frame <= localTotalFrames && !kf.error).sort((a, b) => a.frame - b.frame); let lastPlottedEndFrame = 0;
    sortedKeyframes.forEach(keyframe => { if (keyframe.frame > lastPlottedEndFrame + 1) { const xStartGap = ((lastPlottedEndFrame) / localTotalFrames) * canvas.width; const xEndGap = ((keyframe.frame - 1) / localTotalFrames) * canvas.width; ctx.fillStyle = '#e0e0e0'; ctx.fillRect(xStartGap, 0, xEndGap - xStartGap, canvas.height); } const segmentStartFrame = keyframe.frame; const keyframeIndex = sortedKeyframes.indexOf(keyframe); const segmentEndFrame = (keyframeIndex + 1 < sortedKeyframes.length) ? sortedKeyframes[keyframeIndex+1].frame - 1 : localTotalFrames;
      if (segmentStartFrame <= segmentEndFrame) { const xStart = ((segmentStartFrame - 1) / localTotalFrames) * canvas.width; const xEnd = (segmentEndFrame / localTotalFrames) * canvas.width; let rectWidth = Math.max(1, xEnd - xStart); let color = '#e0e0e0'; if (keyframe.score !== null) { let normalizedScore = 0.5; if (globalMaxScore > globalMinScore && globalMinScore !== Infinity && globalMaxScore !== -Infinity) { normalizedScore = (keyframe.score - globalMinScore) / (globalMaxScore - globalMinScore); } else if (globalMaxScore === globalMinScore && globalMinScore !== Infinity) { normalizedScore = 0.5; } const hue = Math.max(0, Math.min(1, normalizedScore)) * 120; color = `hsl(${hue}, 70%, 50%)`; } ctx.fillStyle = color; ctx.fillRect(xStart, 0, rectWidth, canvas.height); } lastPlottedEndFrame = segmentEndFrame; });
    if (lastPlottedEndFrame < localTotalFrames) { const xStart = (lastPlottedEndFrame / localTotalFrames) * canvas.width; ctx.fillStyle = '#e0e0e0'; ctx.fillRect(xStart, 0, canvas.width - xStart, canvas.height); }
    // Removed overall best frame drawing from canvas - will use overlay div
  }, [heatmapVersion, stableRefs.totalFrames, videoSrc, globalHeatmapCanvasWidth]);

  // Resize observer for global heatmap canvas container
  useEffect(() => { 
    const container = globalHeatmapContainerRef.current; if (!container) return; const resizeObserver = new ResizeObserver(entries => { for (let entry of entries) { setGlobalHeatmapCanvasWidth(entry.contentRect.width); } }); resizeObserver.observe(container); setGlobalHeatmapCanvasWidth(container.offsetWidth); return () => resizeObserver.disconnect();
  }, [videoSrc]);

  // --- User Interaction Handlers ---
  const triggerPriorityAnalysis = useCallback((centerFrame) => {
    if (stableRefs.totalFrames === 0 || centerFrame === 0 || analysisTaskController.isGloballyCancelled) return;
    
    analysisTaskController.currentFocusedCenterFrame = centerFrame;
    setUiFocusedCenterFrame(centerFrame); // Update UI state for focused center
    setShowFocusedHeatmap(true);

    const radius = stableRefs.localViewRadius; // Use from stableRefs
    const newPT = [];
    for (let i = 0; i <= radius; i++) {
      if (i === 0) {
        if (!analysisTaskController.analyzedScores.has(centerFrame) || analysisTaskController.analyzedScores.get(centerFrame)?.error) {
          newPT.push(centerFrame);
        }
      } else {
        const pF = centerFrame - i;
        const nF = centerFrame + i;
        if (pF >= 1 && (!analysisTaskController.analyzedScores.has(pF) || analysisTaskController.analyzedScores.get(pF)?.error)) {
          newPT.push(pF);
        }
        if (nF <= stableRefs.totalFrames && (!analysisTaskController.analyzedScores.has(nF) || analysisTaskController.analyzedScores.get(nF)?.error)) {
          newPT.push(nF);
        }
      }
    }
    const uNT = [...new Set(newPT)];
    analysisTaskController.priorityQueue = [...uNT, ...analysisTaskController.priorityQueue.filter(p => !uNT.includes(p))];
    analysisTaskController.isRecursiveAnalysisPaused = true;
    if (uNT.length > 0) scheduleNextAnalysis();
  }, [stableRefs, setShowFocusedHeatmap, scheduleNextAnalysis, setUiFocusedCenterFrame]);


  const handleFileDrop = (file) => { 
    if (file.type.startsWith('video/')) { if (analysisTaskController.nextScheduledAnalysisId) cancelAnimationFrame(analysisTaskController.nextScheduledAnalysisId); analysisTaskController.isGloballyCancelled = true; analysisTaskController.activeAnalysisProcesses = 0; workerTaskCallbacks.current.forEach(t => t.reject(new Error("New file"))); workerTaskCallbacks.current.clear(); workerBusyStates.current.fill(false); setVideoFile(file); const url = URL.createObjectURL(file); setVideoSrc(url); setCurrentTime(0); setDuration(0); setCurrentFrameNumber(0); setTotalFrames(0); setIsPlaying(false); setFrameRate(DEFAULT_FRAME_RATE); setShowFocusedHeatmap(false); setFocusedHeatmapData([]); setGlobalHeatmapCanvasWidth(0); setUiFocusedCenterFrame(0); return false; } message.error('Invalid video file.'); return Upload.LIST_IGNORE;
  };
  const onVisibleVideoMetadataLoaded = () => {  if (visibleVideoRef.current) setDuration(visibleVideoRef.current.duration); if (analysisVideoRef.current && videoSrc) analysisVideoRef.current.load(); };
  const handleTimeUpdate = () => {  if (visibleVideoRef.current && !analysisTaskController.isSeekingVideoLocked && !stableRefs.isUserInteracting && !visibleVideoRef.current.seeking) { const nT = visibleVideoRef.current.currentTime; if (Math.abs(stableRefs.currentTime - nT) > TIME_EPSILON * 2) setCurrentTime(nT); } };
  const handlePlayPause = () => {  if (visibleVideoRef.current && stableRefs.totalFrames > 0) { if (stableRefs.isPlaying) { visibleVideoRef.current.pause(); setIsPlaying(false); } else { analysisTaskController.isRecursiveAnalysisPaused = false; setShowFocusedHeatmap(false); visibleVideoRef.current.play().catch(e => console.warn("Play failed:", e)); setIsPlaying(true); } } };

  const userInitiatedSeekAction = useCallback(async (targetTime) => { 
    if (!visibleVideoRef.current || analysisTaskController.isGloballyCancelled) return; setIsUserInteracting(true); analysisTaskController.isRecursiveAnalysisPaused = true; const videoWasPlaying = stableRefs.isPlaying; if (videoWasPlaying) { visibleVideoRef.current.pause(); setIsPlaying(false); } try { await seekVideoElement(visibleVideoRef.current, targetTime, false); const newFP = timeToFrame(visibleVideoRef.current.currentTime); if (newFP > 0) triggerPriorityAnalysis(newFP); } catch (error) { message.error("Seek failed."); } if (videoWasPlaying && visibleVideoRef.current && visibleVideoRef.current.src === stableRefs.videoSrc) { visibleVideoRef.current.play().catch(e => console.warn("Play after seek:", e)); setIsPlaying(true); }
  }, [seekVideoElement, triggerPriorityAnalysis, timeToFrame, setIsPlaying, stableRefs]);

  const userInteractionTimeoutRef = useRef(null);
  const commonUserActionEnd = useCallback(() => { 
    if (userInteractionTimeoutRef.current) clearTimeout(userInteractionTimeoutRef.current);
    userInteractionTimeoutRef.current = setTimeout(() => { setIsUserInteracting(false); if (analysisTaskController.priorityQueue.length === 0) analysisTaskController.isRecursiveAnalysisPaused = false; if (analysisTaskController.activeAnalysisProcesses === 0 && (analysisTaskController.priorityQueue.length > 0 || analysisTaskController.recursiveQueue.length > 0)) scheduleNextAnalysis(); }, USER_INTERACTION_SETTLE_DELAY);
  }, [scheduleNextAnalysis]);

  // Slider handlers removed as slider component is removed
  // const handleSliderChange = (newFrameNumber) => { ... };
  // const handleSliderAfterChange = (newFrameNumber) => { ... };

  const handleHeatmapSegmentClick = (targetFrame) => {  if (targetFrame === null || targetFrame === undefined || targetFrame <= 0 || targetFrame > stableRefs.totalFrames) return; setIsUserInteracting(true); const time = frameToTime(targetFrame); userInitiatedSeekAction(time).finally(commonUserActionEnd); };
  const handleGlobalHeatmapCanvasClick = (event) => {  if (!globalHeatmapCanvasRef.current || stableRefs.totalFrames === 0 || stableRefs.isUserInteracting) return; const canvas = globalHeatmapCanvasRef.current; const rect = canvas.getBoundingClientRect(); const x = event.clientX - rect.left; const clickedFrame = Math.floor((x / canvas.width) * stableRefs.totalFrames) + 1; const targetFrame = Math.max(1, Math.min(clickedFrame, stableRefs.totalFrames)); handleHeatmapSegmentClick(targetFrame); };
  const handleStepFrame = (direction) => {  setIsUserInteracting(true); if (stableRefs.totalFrames > 0) { let tF = stableRefs.currentFrameNumber + direction; tF = Math.max(1, Math.min(tF, stableRefs.totalFrames)); if (tF === stableRefs.currentFrameNumber && Math.abs(frameToTime(stableRefs.currentFrameNumber) - frameToTime(tF)) < TIME_EPSILON) { setIsUserInteracting(false); if (analysisTaskController.priorityQueue.length === 0) analysisTaskController.isRecursiveAnalysisPaused = false; return; } userInitiatedSeekAction(frameToTime(tF)).finally(commonUserActionEnd); } else { setIsUserInteracting(false); if (analysisTaskController.priorityQueue.length === 0) analysisTaskController.isRecursiveAnalysisPaused = false; } };
  
  const handleVisibleVideoSeeked = useCallback(() => {
    if (visibleVideoRef.current && !stableRefs.isUserInteracting && stableRefs.totalFrames > 0 && !visibleVideoRef.current.paused === stableRefs.isPlaying) {
      // This check `!visibleVideoRef.current.paused === stableRefs.isPlaying` attempts to ensure this wasn't triggered by our own play/pause then seek
      const newTime = visibleVideoRef.current.currentTime;
      const newFrame = timeToFrame(newTime);
      // Only trigger if the frame actually changed AND it's not already the center of our focus
      if (newFrame > 0 && newFrame !== stableRefs.uiFocusedCenterFrame) {
         setIsUserInteracting(true); // To prevent race conditions with other interactions
         triggerPriorityAnalysis(newFrame);
         commonUserActionEnd(); 
      }
    }
  }, [timeToFrame, triggerPriorityAnalysis, stableRefs, commonUserActionEnd, setIsUserInteracting]);

  const formatFrameForFilename = (frameNum) => `frame_${String(frameNum).padStart(6, '0')}`;
  const handleDownloadFrame = () => {  if (!visibleVideoRef.current || !downloadCanvasRef.current || currentFrameNumber === 0) return; const v = visibleVideoRef.current; const c = downloadCanvasRef.current; c.width=v.videoWidth; c.height=v.videoHeight; const ctx = c.getContext('2d'); ctx.drawImage(v,0,0,c.width,c.height); const dU=c.toDataURL('image/png'); const a=document.createElement('a');a.href=dU;const fNB=videoFile?.name.replace(/[^a-zA-Z0-9_.-]/g,'_')||'video'; a.download=`${fNB}_${formatFrameForFilename(currentFrameNumber)}.png`;document.body.appendChild(a);a.click();document.body.removeChild(a); message.success(`F${currentFrameNumber} downloaded!`); };

  // --- Button Handlers ---
  const handleGoToOverallBestFrame = () => {
    if (overallBestFrame && overallBestFrame.frame > 0 && !overallBestFrame.error) {
      handleHeatmapSegmentClick(overallBestFrame.frame);
    } else {
      message.info("Overall best frame not determined yet or has an error.");
    }
  };

  const handleGoToLocalBestFrame = () => {
    if (showFocusedHeatmap && focusedHeatmapData.length > 0) {
      const localBest = focusedHeatmapData.find(d => d.isLocalBest);
      if (localBest && localBest.frame > 0 && !localBest.error) {
        handleHeatmapSegmentClick(localBest.frame);
      } else {
        message.info("Local best frame not determined in current focused view, or has an error.");
      }
    } else {
      message.info("Focused view not active to determine local best frame.");
    }
  };

  // --- Style for focused range indicator on main timeline ---
  const focusedRangeIndicatorStyle = useMemo(() => { 
    if (!showFocusedHeatmap || focusedHeatmapData.length === 0 || !stableRefs.totalFrames || uiFocusedCenterFrame === 0) return { display: 'none' };
    // Use uiFocusedCenterFrame and localViewRadius to define the range
    const center = uiFocusedCenterFrame;
    const radius = localViewRadius;
    const minFrameInFocus = Math.max(1, center - radius);
    const maxFrameInFocus = Math.min(stableRefs.totalFrames, center + radius);

    if (minFrameInFocus > maxFrameInFocus) return { display: 'none' };

    const leftPercentage = ((minFrameInFocus - 1) / stableRefs.totalFrames) * 100;
    const widthPercentage = ((maxFrameInFocus - minFrameInFocus + 1) / stableRefs.totalFrames) * 100;
    return { display: 'block', position: 'absolute', top: '0px', left: `${Math.max(0, Math.min(100, leftPercentage))}%`, width: `${Math.max(0, Math.min(100, widthPercentage))}%`, height: '100%', };
  }, [showFocusedHeatmap, uiFocusedCenterFrame, localViewRadius, stableRefs.totalFrames, focusedHeatmapData.length]); // Use uiFocusedCenterFrame and localViewRadius

  // --- Style for overall best frame indicator ---
  const overallBestFrameIndicatorStyle = useMemo(() => {
    if (!overallBestFrame || !overallBestFrame.frame || totalFrames <= 0 || overallBestFrame.error) return { display: 'none' };
    const frameNumber = overallBestFrame.frame;
    if (frameNumber < 1 || frameNumber > totalFrames) return { display: 'none' };

    const singleFrameWidthPercentage = (1 / totalFrames) * 100;
    const leftPercentage = ((frameNumber - 1) / totalFrames) * 100;

    return {
      display: 'block',
      position: 'absolute',
      top: '0px',
      left: `${leftPercentage}%`,
      width: `${Math.max(0.1, singleFrameWidthPercentage)}%`,
      minWidth: '3px',
      height: '100%',
      backgroundColor: 'rgba(255, 215, 0, 0.5)',
      borderLeft: '1px solid orange',
      borderRight: '1px solid orange',
      zIndex: 4, 
      pointerEvents: 'none',
      boxSizing: 'border-box',
    };
  }, [overallBestFrame, totalFrames]);


  return (
    <Layout className="app-layout">
      <Header className="app-header"><Title level={2} style={{ color: 'white', margin: 0 }}>Sharp Frame Picker</Title></Header>
      <Content className="app-content">
        {!videoSrc && ( <Upload.Dragger name="file" multiple={false} accept="video/*" beforeUpload={handleFileDrop} showUploadList={false} className="video-dropzone" > <p className="ant-upload-drag-icon"><InboxOutlined /></p> <p className="ant-upload-text">Drop video</p> <p className="ant-upload-hint">Local processing. Max {NUM_WORKERS} parallel analyses.</p> </Upload.Dragger> )}
        {videoSrc && (
          <div className="video-player-container">
            <video key={videoSrc + "-visible"} ref={visibleVideoRef} src={videoSrc} className="video-element"
              onLoadedMetadata={onVisibleVideoMetadataLoaded} onTimeUpdate={handleTimeUpdate}
              onPlay={() => { setIsPlaying(true); analysisTaskController.isRecursiveAnalysisPaused = false; setShowFocusedHeatmap(false);}}
              onPause={() => setIsPlaying(false)} onClick={handlePlayPause} 
              onSeeked={handleVisibleVideoSeeked} // Added onSeeked handler
              controls preload="metadata"
            />
            <video key={videoSrc + "-analysis"} ref={analysisVideoRef} src={videoSrc} className="analysis-video-element" muted preload="auto"
              onLoadedMetadata={() => { if (analysisVideoRef.current && stableRefs.duration > 0 && Math.abs(analysisVideoRef.current.duration - stableRefs.duration) > 0.1) console.warn("Analysis video duration mismatch"); }}
            />
            {(duration > 0 && totalFrames > 0) && (
              <div className="controls-wrapper">
                <div className="timeline-section">
                  {/* Slider removed */}
                  {/* <Slider value={currentFrameNumber} min={1} max={totalFrames} step={1} onChange={handleSliderChange} onAfterChange={handleSliderAfterChange}
                    tooltip={{ formatter: (value) => (value > 0) ? `F${value}` : '' }} disabled={totalFrames === 0 || isUserInteracting} /> */}
                  
                  <div ref={globalHeatmapContainerRef} className="global-heatmap-canvas-container">
                    <canvas ref={globalHeatmapCanvasRef} onClick={handleGlobalHeatmapCanvasClick} className="global-heatmap-canvas" />
                    <div className="focused-range-indicator" style={focusedRangeIndicatorStyle} />
                    {/* Overall best frame indicator overlay */}
                    {overallBestFrame && overallBestFrame.frame > 0 && !overallBestFrame.error && (
                      <Tooltip title={`Overall Best: F${overallBestFrame.frame}, Score: ${overallBestFrame.score?.toFixed(3)}`}>
                        <div style={overallBestFrameIndicatorStyle} />
                      </Tooltip>
                    )}
                  </div>

                  {showFocusedHeatmap && focusedHeatmapData.length > 0 && (
                    <div className="focused-heatmap-wrapper">
                        <Space direction="horizontal" align="center" style={{ marginBottom: '8px'}}>
                            <Typography.Text style={{fontSize: '0.9em'}}>Local View Radius:</Typography.Text>
                            <InputNumber 
                                min={1} 
                                max={Math.min(50, Math.floor(totalFrames / 2))} // Reasonable max
                                value={localViewRadius} 
                                onChange={(value) => { if (value) setLocalViewRadius(value); }}
                                disabled={isUserInteracting}
                                size="small"
                            />
                        </Space>
                        <div className="focused-heatmap-container">
                        {focusedHeatmapData.map(data => {
                            let segmentColor = '#e0e0e0'; // Default for pending/unknown
                            if (data.error) { segmentColor = '#a0a0a0'; } // Grey for error
                            else if (data.score !== null) { const hue = Math.max(0, Math.min(1, data.normalizedScoreLocal)) * 120; segmentColor = `hsl(${hue}, 70%, 50%)`; }
                            else if (data.needsAnalysis) { segmentColor = '#ccc'; } // Lighter grey for queued/analyzing
                            
                            const title = `F${data.frame}${data.error ? ' (Error)' : (data.score !== null ? `, Score: ${data.score.toFixed(3)}` : (data.needsAnalysis ? ' (Queued/Analyzing...)' : ' (Pending Score)'))}`;
                            return (
                            <Tooltip key={`focused-${data.frame}`} title={title}>
                                <div
                                  className={`focused-heatmap-segment ${data.isLocalBest ? 'focused-heatmap-segment-local-best' : ''}`}
                                  style={{ backgroundColor: segmentColor }}
                                  onClick={() => !stableRefs.isUserInteracting && handleHeatmapSegmentClick(data.frame)} >
                                {data.isCenter && <CaretUpOutlined className="focused-heatmap-caret" />}
                                </div>
                            </Tooltip>
                            );
                        })}
                        </div>
                    </div>
                  )}
                </div>
                <Space className="time-display"><span>F{currentFrameNumber>0?currentFrameNumber:0}</span>/<span>{totalFrames>0?totalFrames:0}</span></Space>
                <Space wrap className="action-buttons-group">
                  <Button icon={isPlaying ? <PauseCircleOutlined /> : <PlayCircleOutlined />} onClick={handlePlayPause} disabled={totalFrames === 0 || isUserInteracting} />
                  <Button icon={<LeftOutlined />} onClick={() => handleStepFrame(-1)} disabled={totalFrames === 0 || currentFrameNumber <= 1 || isUserInteracting} />
                  <Button icon={<RightOutlined />} onClick={() => handleStepFrame(1)} disabled={totalFrames === 0 || currentFrameNumber >= totalFrames || isUserInteracting} />
                  
                  <Tooltip title="Go to Overall Best Frame">
                    <Button icon={<StarOutlined />} onClick={handleGoToOverallBestFrame} disabled={!overallBestFrame || overallBestFrame.error || totalFrames === 0 || isUserInteracting} />
                  </Tooltip>
                  <Tooltip title="Go to Local Best Frame (in focused view)">
                    <Button icon={<EyeOutlined />} onClick={handleGoToLocalBestFrame} disabled={!showFocusedHeatmap || focusedHeatmapData.length === 0 || focusedHeatmapData.every(d => !d.isLocalBest || d.error) || totalFrames === 0 || isUserInteracting} />
                  </Tooltip>

                  <Button type="primary" icon={<DownloadOutlined />} onClick={handleDownloadFrame} disabled={totalFrames === 0 || currentFrameNumber === 0 || isUserInteracting} />
                </Space>
              </div>
            )}
          </div>
        )}
        <canvas ref={analysisCanvasRef} style={{ display: 'none' }} />
        <canvas ref={downloadCanvasRef} style={{ display: 'none' }} />
      </Content>
      <Footer style={{ textAlign: 'center', background: '#f0f2f5' }}><Paragraph type="secondary">Sharp Frame Picker ©{new Date().getFullYear()}. (Assumes {DEFAULT_FRAME_RATE} FPS if not detected)</Paragraph></Footer>
    </Layout>
  );
}
export default App;