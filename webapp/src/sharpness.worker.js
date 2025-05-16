// FILE: sharpness.worker.js

const toGrayscale = (r, g, b) => (r + g + b) / 3;

// Helper for 3x3 Median Filter
const getMedian = (values) => {
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)];
};

// "Best Effort" Advanced Sharpness Metric: Normalized Local Contrast over Strong Edges
const calculateAdvancedPerceptualSharpness = (imageDataData, width, height) => {
  if (!imageDataData || width < 5 || height < 5) { // Need at least 5x5 for local window + Sobel
    return 0;
  }

  const data = imageDataData;
  const grayscale = new Float32Array(width * height);

  // 1. Convert to Grayscale
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      grayscale[y * width + x] = toGrayscale(data[i], data[i+1], data[i+2]);
    }
  }

  // 2. Noise Reduction: Apply 3x3 Median Filter
  const smoothedGrayscale = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x === 0 || x === width - 1 || y === 0 || y === height - 1) {
        smoothedGrayscale[y * width + x] = grayscale[y * width + x];
      } else {
        const neighbors = [
          grayscale[(y - 1) * width + (x - 1)], grayscale[(y - 1) * width + x], grayscale[(y - 1) * width + (x + 1)],
          grayscale[y       * width + (x - 1)], grayscale[y       * width + x], grayscale[y       * width + (x + 1)],
          grayscale[(y + 1) * width + (x - 1)], grayscale[(y + 1) * width + x], grayscale[(y + 1) * width + (x + 1)],
        ];
        smoothedGrayscale[y * width + x] = getMedian(neighbors);
      }
    }
  }

  // Sobel Kernels
  const Gx_kernel = [[-1, 0, 1], [-2, 0, 2], [-1, 0, 1]];
  const Gy_kernel = [[-1, -2, -1], [0, 0, 0], [1, 2, 1]];

  const gradientMagnitudes = new Float32Array(width * height);
  
  // EDGE_STRENGTH_THRESHOLD: Determines pixels considered for detailed local analysis.
  // Relative to Sobel magnitudes on 0-255 grayscale.
  // Needs tuning! Start moderately, e.g., 30-60.
  const EDGE_STRENGTH_THRESHOLD = 40; // TUNABLE

  // 3. Calculate Sobel Gradients and Magnitudes
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      let gx = 0;
      let gy = 0;
      for (let ky = -1; ky <= 1; ky++) {
        for (let kx = -1; kx <= 1; kx++) {
          // Use smoothedGrayscale for gradient calculation
          const pixelVal = smoothedGrayscale[(y + ky) * width + (x + kx)];
          gx += pixelVal * Gx_kernel[ky + 1][kx + 1];
          gy += pixelVal * Gy_kernel[ky + 1][kx + 1];
        }
      }
      gradientMagnitudes[y * width + x] = Math.sqrt(gx * gx + gy * gy);
    }
  }

  let overallSharpnessScore = 0;
  let contributingPixels = 0;

  // LOCAL_WINDOW_RADIUS for local mean calculation (e.g., 2 for a 5x5 window)
  const LOCAL_WINDOW_RADIUS = 2;
  const epsilon = 1e-5; // To avoid division by zero

  // 4. For pixels with strong gradients, calculate a normalized local score
  for (let y = LOCAL_WINDOW_RADIUS + 1; y < height - LOCAL_WINDOW_RADIUS - 1; y++) {
    for (let x = LOCAL_WINDOW_RADIUS + 1; x < width - LOCAL_WINDOW_RADIUS - 1; x++) {
      const currentGradientMagnitude = gradientMagnitudes[y * width + x];

      if (currentGradientMagnitude > EDGE_STRENGTH_THRESHOLD) {
        let localSum = 0;
        let localPixelCount = 0;

        // Calculate mean intensity in a local window around the edge pixel
        // using the (original or smoothed) grayscale image
        for (let wy = -LOCAL_WINDOW_RADIUS; wy <= LOCAL_WINDOW_RADIUS; wy++) {
          for (let wx = -LOCAL_WINDOW_RADIUS; wx <= LOCAL_WINDOW_RADIUS; wx++) {
            localSum += smoothedGrayscale[(y + wy) * width + (x + wx)]; // Use smoothed for consistency
            localPixelCount++;
          }
        }
        
        const localMeanIntensity = localPixelCount > 0 ? localSum / localPixelCount : 0;

        // Score contribution: Gradient magnitude normalized by local mean intensity.
        // This gives higher scores to strong edges in darker regions (more perceptible)
        // and adjusts for overall brightness.
        if (localMeanIntensity > epsilon) { // Avoid division by zero or near-zero for very dark patches
            overallSharpnessScore += currentGradientMagnitude / localMeanIntensity;
        } else {
            overallSharpnessScore += currentGradientMagnitude; // Fallback for very dark areas
        }
        contributingPixels++;
      }
    }
  }
  
  // console.log(`Advanced Score: ${overallSharpnessScore}, Contributing Pixels: ${contributingPixels}`);

  if (contributingPixels === 0) {
    return 0; // Very blurry or no significant edges found
  }

  // Return the sum of normalized gradient magnitudes. Higher is sharper.
  // Averaging (overallSharpnessScore / contributingPixels) is also an option
  // if you want to reduce the impact of the sheer number of edges.
  return overallSharpnessScore;
};


self.onmessage = (event) => {
  const { id, imageDataBuffer, width, height } = event.data;
  try {
    const imageDataClampedArray = new Uint8ClampedArray(imageDataBuffer);
    const score = calculateAdvancedPerceptualSharpness(imageDataClampedArray, width, height);
    self.postMessage({ id, score, status: 'success' });
  } catch (error) {
    console.error("Worker Error in onmessage:", error);
    self.postMessage({ id, error: error.message || 'Unknown worker error', status: 'error' });
  }
};