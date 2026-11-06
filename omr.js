/* OMR AutoGrader — Sheet geometry, PDF generation and vision engine.
 * Geometry and detection thresholds are identical to the original tool so that
 * sheets already printed with the old generator remain readable.
 */
window.OMR = (function () {
  'use strict';

  const SHEET_LAYOUT = {
    markerSize: 12,     // black square markers are 12mm x 12mm
    markerLeft: 10,     // left markers' top-left corner x
    markerRight: 188,   // right markers' top-left corner x
    markerTop: 10,      // top markers' top-left corner y
    markerBottom: 275,  // bottom markers' top-left corner y

    // Student ID grid (7 digits, 0-9)
    idDigits: 7,
    idStartX: 28,
    idStartY: 58,
    idStepX: 7.5,
    idStepY: 5.5,

    // Test item layout
    startX: 95,
    startY: 58,
    rowStep: 8.5,
    colStep: 52,
    itemsPerColumn: 20,
    bubbleOffsetX: 8,
    bubbleStepX: 7.5,
    bubbleYAdjust: -1.2,
    bubbleRadius: 2.2
  };

  const CHOICE_LETTERS = ['A', 'B', 'C', 'D', 'E'];

  function markerFrame(layout) {
    const half = layout.markerSize / 2;
    return {
      left: layout.markerLeft + half,
      top: layout.markerTop + half,
      right: layout.markerRight + half,
      bottom: layout.markerBottom + half
    };
  }

  // Physical mm position of a given item/choice bubble's center.
  function bubbleMM(item, choiceIdx, layout) {
    const rowIdx = (item - 1) % layout.itemsPerColumn;
    const colIdx = Math.floor((item - 1) / layout.itemsPerColumn);
    return {
      x: layout.startX + colIdx * layout.colStep + layout.bubbleOffsetX + choiceIdx * layout.bubbleStepX,
      y: layout.startY + rowIdx * layout.rowStep + layout.bubbleYAdjust
    };
  }

  // Physical mm position of a given student-ID digit bubble's center.
  function idBubbleMM(colIdx, digitVal, layout) {
    return {
      x: layout.idStartX + colIdx * layout.idStepX,
      y: layout.idStartY + digitVal * layout.idStepY
    };
  }

  // ---------- PDF generation ----------
  function generatePDFSheet(opts) {
    const itemCount = opts.itemCount;
    const choicesCount = opts.choicesCount;
    const markAsKey = !!opts.markAsKey;
    const examTitle = (opts.examTitle || '').trim();
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const labels = CHOICE_LETTERS.slice(0, choicesCount);
    const layout = SHEET_LAYOUT;

    // Corner markers
    doc.setFillColor(0, 0, 0);
    doc.rect(10, 10, 12, 12, 'F');
    doc.rect(188, 10, 12, 12, 'F');
    doc.rect(10, 275, 12, 12, 'F');
    doc.rect(188, 275, 12, 12, 'F');

    // Title & header
    doc.setFont('Helvetica', 'bold');
    doc.setFontSize(16);
    doc.text(examTitle ? examTitle.slice(0, 52) : 'OMR ANSWER SHEET', 105, 18, { align: 'center' });

    if (markAsKey) {
      doc.setTextColor(200, 30, 60);
      doc.setFontSize(11);
      doc.text('ANSWER KEY COPY', 105, 24, { align: 'center' });
      doc.setTextColor(0, 0, 0);
    }

    // Metadata header box
    doc.setDrawColor(0, 0, 0);
    doc.setLineWidth(0.4);
    doc.rect(25, 26, 160, 18);
    doc.setFontSize(9);
    doc.setFont('Helvetica', 'normal');
    doc.text('Student Name: _________________________________', 28, 33);
    doc.text('Section: __________________', 28, 39);
    doc.text('Date: ____________', 130, 39);

    // Student ID section
    doc.setFont('Helvetica', 'bold');
    doc.setFontSize(8);
    doc.text('STUDENT ID', layout.idStartX - 2, layout.idStartY - 11);

    doc.setFontSize(6);
    doc.setFont('Helvetica', 'normal');
    doc.text('Write the ID in the boxes, then fill the matching bubbles', layout.idStartX + 24, layout.idStartY - 11);

    const firstBubbleY = idBubbleMM(0, 0, layout).y;
    const boxWidth = 5;
    const boxHeight = 5;
    const boxY = firstBubbleY - layout.bubbleRadius - boxHeight - 1.5;

    for (let c = 0; c < layout.idDigits; c++) {
      doc.rect(idBubbleMM(c, 0, layout).x - boxWidth / 2, boxY, boxWidth, boxHeight);
    }

    for (let c = 0; c < layout.idDigits; c++) {
      for (let d = 0; d <= 9; d++) {
        const pos = idBubbleMM(c, d, layout);
        doc.circle(pos.x, pos.y, layout.bubbleRadius, 'S');
        doc.setFontSize(6);
        doc.text(String(d), pos.x - 0.7, pos.y + 0.8);
      }
    }

    // Answer bubbles
    doc.setFontSize(9);
    for (let i = 1; i <= itemCount; i++) {
      const rowIdx = (i - 1) % layout.itemsPerColumn;
      const colIdx = Math.floor((i - 1) / layout.itemsPerColumn);
      const currentY = layout.startY + rowIdx * layout.rowStep;
      const currentX = layout.startX + colIdx * layout.colStep;

      doc.text(`${i}.`, currentX, currentY);

      labels.forEach((label, idx) => {
        const pos = bubbleMM(i, idx, layout);
        doc.circle(pos.x, pos.y, layout.bubbleRadius, 'S');
        doc.setFontSize(6.5);
        doc.text(label, pos.x - 0.7, pos.y + 0.9);
        doc.setFontSize(9);
      });
    }

    const safeTitle = examTitle ? examTitle.replace(/[^a-z0-9\-]+/gi, '_').slice(0, 30) : 'OMR_Sheet';
    doc.save(`${safeTitle}_${itemCount}Items${markAsKey ? '_KEY' : ''}.pdf`);
  }

  // ---------- OMR engine ----------
  function fillDensity(warped, centerX, centerY, radius, W, H) {
    let filledPixels = 0;
    let count = 0;
    for (let py = centerY - radius; py <= centerY + radius; py++) {
      for (let px = centerX - radius; px <= centerX + radius; px++) {
        if (px >= 0 && px < W && py >= 0 && py < H) {
          if (Math.hypot(px - centerX, py - centerY) <= radius) {
            count++;
            if (warped.ucharPtr(py, px)[0] > 0) filledPixels++;
          }
        }
      }
    }
    return filledPixels / (count || 1);
  }

  /**
   * Reads a sheet from the given canvas.
   * @returns {{aligned:boolean, studentId:string, detected:Object, bubbles:Array,
   *            idBubbles:Array, margin:Object, ambiguous:number[]}}
   */
  function runOMREngine(canvasId, totalItems, choicesCount) {
    let src = cv.imread(canvasId);
    let gray = new cv.Mat();
    let blur = new cv.Mat();
    let thresh = new cv.Mat();

    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
    cv.adaptiveThreshold(blur, thresh, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 19, 9);

    let contours = new cv.MatVector();
    let hierarchy = new cv.Mat();
    cv.findContours(thresh, contours, hierarchy, cv.RETR_TREE, cv.CHAIN_APPROX_SIMPLE);

    let cornerCandidates = [];
    let totalArea = thresh.cols * thresh.rows;

    for (let i = 0; i < contours.size(); ++i) {
      let cnt = contours.get(i);
      let area = cv.contourArea(cnt);
      let rect = cv.boundingRect(cnt);
      let aspectRatio = rect.width / parseFloat(rect.height);

      if (area > (totalArea * 0.0005) && area < (totalArea * 0.03)) {
        if (aspectRatio >= 0.75 && aspectRatio <= 1.25) {
          let hull = new cv.Mat();
          cv.convexHull(cnt, hull);
          let solidity = area / (cv.contourArea(hull) || 1);
          hull.delete();

          if (solidity > 0.85) {
            cornerCandidates.push({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, area: area });
          }
        }
      }
      cnt.delete();
    }

    const frame = markerFrame(SHEET_LAYOUT);
    const PX_PER_MM = 4;
    const W = Math.round((frame.right - frame.left) * PX_PER_MM);
    const H = Math.round((frame.bottom - frame.top) * PX_PER_MM);
    const expectedRatio = (frame.right - frame.left) / (frame.bottom - frame.top);

    function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

    let warpedGray = new cv.Mat();
    let warped = new cv.Mat();
    let aligned = false;

    if (cornerCandidates.length >= 4) {
      cornerCandidates.sort((a, b) => b.area - a.area);
      let top4 = cornerCandidates.slice(0, 4);

      let sums = top4.map(p => p.x + p.y);
      let diffs = top4.map(p => p.y - p.x);

      let topLeft = top4[sums.indexOf(Math.min(...sums))];
      let bottomRight = top4[sums.indexOf(Math.max(...sums))];
      let topRight = top4[diffs.indexOf(Math.min(...diffs))];
      let bottomLeft = top4[diffs.indexOf(Math.max(...diffs))];

      const measuredWidth = (dist(topLeft, topRight) + dist(bottomLeft, bottomRight)) / 2;
      const measuredHeight = (dist(topLeft, bottomLeft) + dist(topRight, bottomRight)) / 2;
      const measuredRatio = measuredWidth / (measuredHeight || 1);
      const ratioError = Math.abs(measuredRatio - expectedRatio) / expectedRatio;

      if (ratioError < 0.25) {
        let srcTri = cv.matFromArray(4, 1, cv.CV_32FC2, [
          topLeft.x, topLeft.y, topRight.x, topRight.y,
          bottomRight.x, bottomRight.y, bottomLeft.x, bottomLeft.y
        ]);
        let dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, W, 0, W, H, 0, H]);

        let M = cv.getPerspectiveTransform(srcTri, dstTri);
        cv.warpPerspective(blur, warpedGray, M, new cv.Size(W, H));
        aligned = true;

        srcTri.delete(); dstTri.delete(); M.delete();
      }
    }

    if (!aligned) {
      cv.resize(blur, warpedGray, new cv.Size(W, H));
    }
    cv.adaptiveThreshold(warpedGray, warped, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 21, 10);

    const radiusPx = SHEET_LAYOUT.bubbleRadius * PX_PER_MM * 0.85;

    // 1. Student ID (7 digits)
    let detectedDigits = [];
    let idBubbles = [];

    for (let c = 0; c < SHEET_LAYOUT.idDigits; c++) {
      let fillDensities = [];
      let positions = [];

      for (let d = 0; d <= 9; d++) {
        const mm = idBubbleMM(c, d, SHEET_LAYOUT);
        const centerX = Math.round((mm.x - frame.left) * PX_PER_MM);
        const centerY = Math.round((mm.y - frame.top) * PX_PER_MM);
        const radius = Math.round(radiusPx);
        positions.push({ x: centerX, y: centerY, r: radius });
        fillDensities.push(fillDensity(warped, centerX, centerY, radius, W, H));
      }

      let maxVal = Math.max(...fillDensities);
      let maxIdx = fillDensities.indexOf(maxVal);
      let unshadedVals = fillDensities.filter((_, idx) => idx !== maxIdx);
      let minVal = Math.min(...unshadedVals);
      let avgUnshaded = unshadedVals.reduce((a, b) => a + b, 0) / unshadedVals.length;

      let detectedDigit = '?';
      if (maxVal >= 0.38 && (maxVal - avgUnshaded) > 0.22 && (maxVal / (minVal || 0.01)) > 1.8) {
        detectedDigit = String(maxIdx);
      }
      detectedDigits.push(detectedDigit);

      for (let d = 0; d <= 9; d++) {
        idBubbles.push({
          digitCol: c,
          digitVal: d,
          x: positions[d].x,
          y: positions[d].y,
          r: positions[d].r,
          isDetected: String(d) === detectedDigit
        });
      }
    }

    const studentId = detectedDigits.join('');

    // 2. Question items
    const labels = CHOICE_LETTERS.slice(0, choicesCount);
    let detected = {};
    let margin = {};
    let bubbles = [];
    let ambiguous = [];

    for (let i = 1; i <= totalItems; i++) {
      let fillDensities = [];
      let positions = [];

      labels.forEach((_, idx) => {
        const mm = bubbleMM(i, idx, SHEET_LAYOUT);
        const centerX = Math.round((mm.x - frame.left) * PX_PER_MM);
        const centerY = Math.round((mm.y - frame.top) * PX_PER_MM);
        const radius = Math.round(radiusPx);
        positions.push({ x: centerX, y: centerY, r: radius });
        fillDensities.push(fillDensity(warped, centerX, centerY, radius, W, H));
      });

      let maxVal = Math.max(...fillDensities);
      let maxIdx = fillDensities.indexOf(maxVal);
      let unshadedVals = fillDensities.filter((_, idx) => idx !== maxIdx);
      let minVal = Math.min(...unshadedVals);
      let avgUnshaded = unshadedVals.reduce((a, b) => a + b, 0) / unshadedVals.length;

      let choice = 'N/A';
      if (maxVal >= 0.40 && (maxVal - avgUnshaded) > 0.25 && (maxVal / (minVal || 0.01)) > 2.0) {
        choice = labels[maxIdx];
        // A shallow margin means the mark was faint or two bubbles were filled.
        if ((maxVal - avgUnshaded) < 0.38) ambiguous.push(i);
      }
      detected[i] = choice;
      margin[i] = +(maxVal - avgUnshaded).toFixed(2);

      labels.forEach((label, idx) => {
        bubbles.push({ item: i, label, x: positions[idx].x, y: positions[idx].y, r: positions[idx].r, isDetected: label === choice });
      });
    }

    cv.imshow('warp-buffer', warped);

    src.delete(); gray.delete(); blur.delete(); thresh.delete();
    contours.delete(); hierarchy.delete(); warped.delete(); warpedGray.delete();

    return { aligned, studentId, detected, bubbles, idBubbles, margin, ambiguous };
  }

  return {
    SHEET_LAYOUT,
    CHOICE_LETTERS,
    markerFrame,
    bubbleMM,
    idBubbleMM,
    generatePDFSheet,
    runOMREngine
  };
})();
