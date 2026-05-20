<template>
  <el-dialog
    v-model="visible"
    title="图片编辑"
    width="min(1200px, 96vw)"
    class="image-mask-dialog"
    destroy-on-close
    @opened="loadImage"
    @closed="resetEditor"
  >
    <div class="mask-editor">
      <aside class="mask-tools">
        <div class="tool-row">
          <el-tooltip content="套圈空白" placement="top">
            <el-button :type="tool === 'blank' ? 'primary' : 'default'" @click="tool = 'blank'">
              <el-icon><Aim /></el-icon>
            </el-button>
          </el-tooltip>
          <el-tooltip content="涂抹擦拭" placement="top">
            <el-button :type="tool === 'brush' ? 'primary' : 'default'" @click="tool = 'brush'">
              <el-icon><Brush /></el-icon>
            </el-button>
          </el-tooltip>
          <el-tooltip content="网状线覆盖" placement="top">
            <el-button :type="tool === 'mesh' ? 'primary' : 'default'" @click="tool = 'mesh'">
              <el-icon><Grid /></el-icon>
            </el-button>
          </el-tooltip>
          <el-tooltip content="马赛克区域" placement="top">
            <el-button :type="tool === 'mosaic' ? 'primary' : 'default'" @click="tool = 'mosaic'">
              <el-icon><Operation /></el-icon>
            </el-button>
          </el-tooltip>
          <el-tooltip content="裁剪" placement="top">
            <el-button :type="tool === 'crop' ? 'primary' : 'default'" @click="tool = 'crop'">
              <el-icon><Crop /></el-icon>
            </el-button>
          </el-tooltip>
        </div>

        <div v-if="usesAreaShape" class="control-block">
          <div class="control-label">区域形状</div>
          <el-radio-group v-model="areaShape" size="small">
            <el-radio-button
              v-for="option in shapeOptions"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }}
            </el-radio-button>
          </el-radio-group>
        </div>

        <div v-if="tool === 'blank' || tool === 'brush'" class="control-block">
          <div class="control-label">遮盖颜色</div>
          <div class="color-line">
            <button
              v-for="color in maskColors"
              :key="color"
              type="button"
              class="color-swatch"
              :class="{ active: maskColor === color }"
              :style="{ background: color }"
              @click="maskColor = color"
            />
            <el-color-picker v-model="maskColor" size="small" />
          </div>
        </div>

        <div v-if="tool === 'mesh'" class="control-block">
          <div class="control-label">网线颜色</div>
          <div class="color-line">
            <button
              v-for="color in meshColors"
              :key="color"
              type="button"
              class="color-swatch"
              :class="{ active: meshColor === color }"
              :style="{ background: color }"
              @click="meshColor = color"
            />
            <el-color-picker v-model="meshColor" size="small" />
          </div>
        </div>

        <div v-if="tool !== 'crop'" class="control-block">
          <div class="control-label">强度 {{ opacity }}%</div>
          <el-slider v-model="opacity" :min="20" :max="100" :step="5" />
        </div>

        <div v-if="tool === 'brush'" class="control-block">
          <div class="control-label">画笔 {{ brushSize }}px</div>
          <el-slider v-model="brushSize" :min="8" :max="180" :step="2" />
        </div>

        <div v-if="tool === 'mesh'" class="control-block">
          <div class="control-label">网格 {{ meshGap }}px</div>
          <el-slider v-model="meshGap" :min="6" :max="44" :step="2" />
          <div class="control-label">线宽 {{ meshWidth }}px</div>
          <el-slider v-model="meshWidth" :min="1" :max="8" :step="1" />
        </div>

        <div v-if="tool === 'mosaic'" class="control-block">
          <div class="control-label">颗粒 {{ mosaicSize }}px</div>
          <el-slider v-model="mosaicSize" :min="6" :max="64" :step="2" />
        </div>

        <div class="control-block">
          <div class="control-label">查看缩放 {{ viewZoom }}%</div>
          <div class="tool-row">
            <el-tooltip content="缩小查看" placement="top">
              <el-button @click="setViewZoom(viewZoom - 25)">
                <el-icon><ZoomOut /></el-icon>
              </el-button>
            </el-tooltip>
            <el-tooltip content="放大查看" placement="top">
              <el-button @click="setViewZoom(viewZoom + 25)">
                <el-icon><ZoomIn /></el-icon>
              </el-button>
            </el-tooltip>
            <el-tooltip content="适应窗口" placement="top">
              <el-button @click="setViewZoom(100)">
                <el-icon><ScaleToOriginal /></el-icon>
              </el-button>
            </el-tooltip>
          </div>
        </div>

        <div class="control-block">
          <div class="control-label">导出缩放 {{ outputScale }}%</div>
          <el-slider v-model="outputScale" :min="25" :max="200" :step="5" />
        </div>

        <div class="control-block">
          <div class="control-label">导出格式</div>
          <el-radio-group v-model="outputType" size="small">
            <el-radio-button value="image/png">PNG</el-radio-button>
            <el-radio-button value="image/jpeg">JPG</el-radio-button>
          </el-radio-group>
          <template v-if="outputType === 'image/jpeg'">
            <div class="control-label">质量 {{ Math.round(jpegQuality * 100) }}%</div>
            <el-slider v-model="jpegQuality" :min="0.6" :max="0.98" :step="0.02" />
          </template>
        </div>

        <div class="tool-row bottom-actions">
          <el-tooltip content="左旋 90°" placement="top">
            <el-button :disabled="loading" @click="rotateCanvas(-90)">
              <el-icon><RefreshLeft /></el-icon>
            </el-button>
          </el-tooltip>
          <el-tooltip content="右旋 90°" placement="top">
            <el-button :disabled="loading" @click="rotateCanvas(90)">
              <el-icon><RefreshRight /></el-icon>
            </el-button>
          </el-tooltip>
          <el-tooltip content="撤销" placement="top">
            <el-button :disabled="!history.length" @click="undo">
              <el-icon><Back /></el-icon>
            </el-button>
          </el-tooltip>
          <el-tooltip content="重做" placement="top">
            <el-button :disabled="!redoStack.length" @click="redo">
              <el-icon><Right /></el-icon>
            </el-button>
          </el-tooltip>
          <el-tooltip content="重置" placement="top">
            <el-button :disabled="loading" @click="loadImage">
              <el-icon><Refresh /></el-icon>
            </el-button>
          </el-tooltip>
        </div>
      </aside>

      <section class="mask-stage">
        <div v-if="loading" class="stage-state">
          <el-icon class="is-loading"><Loading /></el-icon>
        </div>
        <div v-else-if="loadError" class="stage-state error-state">{{ loadError }}</div>
        <div v-show="!loadError" class="canvas-scroll" :class="{ 'canvas-scroll--loading': loading }">
          <div class="canvas-wrap" :class="{ brushing: tool === 'brush' }">
            <canvas
              ref="canvasRef"
              :style="{ width: displaySize.width + 'px', height: displaySize.height + 'px' }"
              @pointerdown="onPointerDown"
              @pointermove="onPointerMove"
              @pointerup="onPointerUp"
              @pointercancel="onPointerCancel"
              @pointerleave="onPointerCancel"
            />
          </div>
        </div>
      </section>
    </div>

    <template #footer>
      <span class="image-size">{{ exportSizeText }}</span>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="saving" :disabled="loading || !!loadError" @click="saveImage">
        保存为新图
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import {
  Aim,
  Back,
  Brush,
  Crop,
  Grid,
  Loading,
  Operation,
  Refresh,
  RefreshLeft,
  RefreshRight,
  Right,
  ScaleToOriginal,
  ZoomIn,
  ZoomOut,
} from '@element-plus/icons-vue'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  src: { type: String, default: '' },
  fileName: { type: String, default: 'edited-image.png' },
})

const emit = defineEmits(['update:modelValue', 'saved'])

const visible = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value),
})

const canvasRef = ref(null)
const tool = ref('blank')
const areaShape = ref('ellipse')
const maskColor = ref('#ffffff')
const meshColor = ref('#111827')
const opacity = ref(100)
const brushSize = ref(56)
const meshGap = ref(14)
const meshWidth = ref(2)
const mosaicSize = ref(18)
const viewZoom = ref(100)
const outputScale = ref(100)
const outputType = ref('image/png')
const jpegQuality = ref(0.92)
const loading = ref(false)
const saving = ref(false)
const loadError = ref('')
const displaySize = reactive({ width: 720, height: 420 })
const imageSize = reactive({ width: 0, height: 0 })
const history = ref([])
const redoStack = ref([])

const shapeOptions = [
  { label: '椭圆', value: 'ellipse' },
  { label: '矩形', value: 'rect' },
]
const maskColors = ['#ffffff', '#111827', '#f5f5f4']
const meshColors = ['#111827', '#ffffff', '#ef4444']
const usesAreaShape = computed(() => ['blank', 'mesh', 'mosaic'].includes(tool.value))
const exportSizeText = computed(() => {
  if (!imageSize.width || !imageSize.height) return ''
  const scale = outputScale.value / 100
  return `${Math.round(imageSize.width * scale)} × ${Math.round(imageSize.height * scale)}`
})

let drawing = false
let startPoint = null
let lastPoint = null
let previewBase = null

watch(
  () => [props.modelValue, props.src],
  ([open]) => {
    if (open) nextTick(loadImage)
  }
)

watch(viewZoom, fitCanvas)
window.addEventListener('resize', fitCanvas)
onBeforeUnmount(() => window.removeEventListener('resize', fitCanvas))

function resetEditor() {
  drawing = false
  startPoint = null
  lastPoint = null
  previewBase = null
  history.value = []
  redoStack.value = []
  loadError.value = ''
  outputScale.value = 100
  outputType.value = 'image/png'
  jpegQuality.value = 0.92
  viewZoom.value = 100
}

function getCanvas() {
  return canvasRef.value
}

function getContext() {
  const canvas = getCanvas()
  return canvas ? canvas.getContext('2d', { willReadFrequently: true }) : null
}

function loadImage() {
  if (!props.src) {
    loadError.value = '图片地址为空'
    return
  }
  const canvas = getCanvas()
  if (!canvas) return
  loading.value = true
  loadError.value = ''
  history.value = []
  redoStack.value = []

  const img = new Image()
  if (!isSameOrigin(props.src)) img.crossOrigin = 'anonymous'
  img.onload = () => {
    Object.assign(imageSize, {
      width: img.naturalWidth || img.width,
      height: img.naturalHeight || img.height,
    })
    canvas.width = imageSize.width
    canvas.height = imageSize.height
    const ctx = getContext()
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    fitCanvas()
    loading.value = false
  }
  img.onerror = () => {
    loading.value = false
    loadError.value = '图片加载失败'
  }
  img.src = props.src
}

function isSameOrigin(src) {
  if (!src || src.startsWith('/') || src.startsWith('data:') || src.startsWith('blob:')) return true
  try {
    return new URL(src, window.location.href).origin === window.location.origin
  } catch (_) {
    return true
  }
}

function setViewZoom(next) {
  viewZoom.value = Math.min(300, Math.max(25, next))
}

function fitCanvas() {
  if (!imageSize.width || !imageSize.height) return
  const sidePanel = window.innerWidth >= 900 ? 320 : 40
  const maxWidth = Math.max(320, Math.min(860, window.innerWidth - sidePanel))
  const maxHeight = Math.max(320, window.innerHeight - 280)
  const fitScale = Math.min(maxWidth / imageSize.width, maxHeight / imageSize.height, 1)
  const scale = fitScale * (viewZoom.value / 100)
  displaySize.width = Math.max(1, Math.round(imageSize.width * scale))
  displaySize.height = Math.max(1, Math.round(imageSize.height * scale))
}

function canvasPoint(event) {
  const canvas = getCanvas()
  const rect = canvas.getBoundingClientRect()
  return {
    x: (event.clientX - rect.left) * (canvas.width / rect.width),
    y: (event.clientY - rect.top) * (canvas.height / rect.height),
  }
}

function currentSnapshot() {
  const canvas = getCanvas()
  const ctx = getContext()
  return {
    width: canvas.width,
    height: canvas.height,
    data: ctx.getImageData(0, 0, canvas.width, canvas.height),
  }
}

function pushHistory() {
  try {
    history.value.push(currentSnapshot())
    if (history.value.length > 30) history.value.shift()
    redoStack.value = []
  } catch (err) {
    console.warn('[ImageMaskEditor] snapshot failed:', err.message)
  }
}

function restore(snapshot, sync = true) {
  if (!snapshot?.data) return
  const canvas = getCanvas()
  const ctx = getContext()
  if (!canvas || !ctx) return
  if (canvas.width !== snapshot.width || canvas.height !== snapshot.height) {
    canvas.width = snapshot.width
    canvas.height = snapshot.height
  }
  ctx.putImageData(snapshot.data, 0, 0)
  if (sync) syncImageSizeFromCanvas()
}

function undo() {
  if (!history.value.length) return
  redoStack.value.push(currentSnapshot())
  restore(history.value.pop())
}

function redo() {
  if (!redoStack.value.length) return
  history.value.push(currentSnapshot())
  restore(redoStack.value.pop())
}

function syncImageSizeFromCanvas() {
  const canvas = getCanvas()
  Object.assign(imageSize, { width: canvas.width, height: canvas.height })
  fitCanvas()
}

function onPointerDown(event) {
  if (loading.value || loadError.value) return
  const canvas = getCanvas()
  canvas.setPointerCapture?.(event.pointerId)
  drawing = true
  startPoint = canvasPoint(event)
  lastPoint = startPoint
  pushHistory()

  if (tool.value === 'brush') {
    drawBrushDot(startPoint)
  } else {
    previewBase = currentSnapshot()
  }
}

function onPointerMove(event) {
  if (!drawing) return
  const point = canvasPoint(event)
  if (tool.value === 'brush') {
    drawBrushLine(lastPoint, point)
    lastPoint = point
    return
  }
  restore(previewBase, false)
  if (tool.value === 'crop') drawCropPreview(startPoint, point)
  else drawArea(startPoint, point)
}

function onPointerUp(event) {
  if (!drawing) return
  const point = canvasPoint(event)
  if (tool.value === 'crop') {
    restore(previewBase, false)
    applyCrop(normalizedRect(startPoint, point))
  } else if (tool.value !== 'brush') {
    restore(previewBase, false)
    drawArea(startPoint, point)
  }
  drawing = false
  startPoint = null
  lastPoint = null
  previewBase = null
}

function onPointerCancel() {
  if (!drawing) return
  if (tool.value !== 'brush') restore(previewBase, false)
  drawing = false
  startPoint = null
  lastPoint = null
  previewBase = null
}

function normalizedRect(a, b) {
  const canvas = getCanvas()
  const x = Math.max(0, Math.min(a.x, b.x))
  const y = Math.max(0, Math.min(a.y, b.y))
  const right = Math.min(canvas.width, Math.max(a.x, b.x))
  const bottom = Math.min(canvas.height, Math.max(a.y, b.y))
  return {
    x,
    y,
    width: Math.max(0, right - x),
    height: Math.max(0, bottom - y),
  }
}

function beginAreaPath(ctx, rect) {
  ctx.beginPath()
  if (areaShape.value === 'ellipse') {
    ctx.ellipse(
      rect.x + rect.width / 2,
      rect.y + rect.height / 2,
      Math.max(1, rect.width / 2),
      Math.max(1, rect.height / 2),
      0,
      0,
      Math.PI * 2
    )
  } else {
    ctx.rect(rect.x, rect.y, rect.width, rect.height)
  }
}

function drawArea(a, b) {
  const rect = normalizedRect(a, b)
  if (rect.width < 2 || rect.height < 2) return
  if (tool.value === 'mesh') drawMesh(rect)
  else if (tool.value === 'mosaic') drawMosaic(rect)
  else drawBlank(rect)
}

function drawBlank(rect) {
  const ctx = getContext()
  ctx.save()
  ctx.globalAlpha = opacity.value / 100
  ctx.fillStyle = maskColor.value
  beginAreaPath(ctx, rect)
  ctx.fill()
  ctx.restore()
}

function drawMesh(rect) {
  const ctx = getContext()
  const gap = Math.max(4, meshGap.value)
  const lineWidth = Math.max(1, meshWidth.value)
  ctx.save()
  beginAreaPath(ctx, rect)
  ctx.clip()
  ctx.globalAlpha = Math.min(1, opacity.value / 100)
  ctx.strokeStyle = meshColor.value
  ctx.lineWidth = lineWidth
  ctx.lineCap = 'square'

  const left = rect.x - rect.height
  const right = rect.x + rect.width + rect.height
  const top = rect.y
  const bottom = rect.y + rect.height

  for (let x = left; x <= right; x += gap) {
    ctx.beginPath()
    ctx.moveTo(x, top)
    ctx.lineTo(x + rect.height, bottom)
    ctx.stroke()
  }
  for (let x = rect.x; x <= right + rect.height; x += gap) {
    ctx.beginPath()
    ctx.moveTo(x, top)
    ctx.lineTo(x - rect.height, bottom)
    ctx.stroke()
  }
  ctx.restore()
}

function drawMosaic(rect) {
  const canvas = getCanvas()
  const ctx = getContext()
  const block = Math.max(4, mosaicSize.value)
  const smallW = Math.max(1, Math.ceil(rect.width / block))
  const smallH = Math.max(1, Math.ceil(rect.height / block))
  const tmp = document.createElement('canvas')
  tmp.width = smallW
  tmp.height = smallH
  const tctx = tmp.getContext('2d')
  tctx.imageSmoothingEnabled = true
  tctx.drawImage(canvas, rect.x, rect.y, rect.width, rect.height, 0, 0, smallW, smallH)

  ctx.save()
  beginAreaPath(ctx, rect)
  ctx.clip()
  ctx.globalAlpha = opacity.value / 100
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(tmp, 0, 0, smallW, smallH, rect.x, rect.y, rect.width, rect.height)
  ctx.restore()
  ctx.imageSmoothingEnabled = true
}

function drawCropPreview(a, b) {
  const rect = normalizedRect(a, b)
  if (rect.width < 2 || rect.height < 2) return
  const canvas = getCanvas()
  const ctx = getContext()
  ctx.save()
  ctx.fillStyle = 'rgba(15, 23, 42, .42)'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.clearRect(rect.x, rect.y, rect.width, rect.height)
  ctx.strokeStyle = '#38bdf8'
  ctx.lineWidth = Math.max(2, canvas.width / displaySize.width)
  ctx.setLineDash([12, 8])
  ctx.strokeRect(rect.x, rect.y, rect.width, rect.height)
  ctx.restore()
}

function applyCrop(rect) {
  if (rect.width < 8 || rect.height < 8) return
  const canvas = getCanvas()
  const ctx = getContext()
  const data = ctx.getImageData(Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height))
  canvas.width = Math.round(rect.width)
  canvas.height = Math.round(rect.height)
  Object.assign(imageSize, { width: canvas.width, height: canvas.height })
  getContext().putImageData(data, 0, 0)
  fitCanvas()
}

function drawBrushDot(point) {
  const ctx = getContext()
  ctx.save()
  ctx.globalAlpha = opacity.value / 100
  ctx.fillStyle = maskColor.value
  ctx.beginPath()
  ctx.arc(point.x, point.y, brushSize.value / 2, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

function drawBrushLine(from, to) {
  const ctx = getContext()
  ctx.save()
  ctx.globalAlpha = opacity.value / 100
  ctx.strokeStyle = maskColor.value
  ctx.lineWidth = brushSize.value
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  ctx.moveTo(from.x, from.y)
  ctx.lineTo(to.x, to.y)
  ctx.stroke()
  ctx.restore()
}

function rotateCanvas(degrees) {
  const canvas = getCanvas()
  const ctx = getContext()
  if (!canvas || !ctx) return
  pushHistory()
  const tmp = document.createElement('canvas')
  tmp.width = canvas.width
  tmp.height = canvas.height
  tmp.getContext('2d').drawImage(canvas, 0, 0)

  const clockwise = degrees > 0
  canvas.width = tmp.height
  canvas.height = tmp.width
  const next = getContext()
  next.save()
  if (clockwise) {
    next.translate(canvas.width, 0)
    next.rotate(Math.PI / 2)
  } else {
    next.translate(0, canvas.height)
    next.rotate(-Math.PI / 2)
  }
  next.drawImage(tmp, 0, 0)
  next.restore()
  syncImageSizeFromCanvas()
}

function outputFileName() {
  const base = String(props.fileName || 'edited-image')
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[\\/:*?"<>|]/g, '_')
  return `${base}_edited.${outputType.value === 'image/jpeg' ? 'jpg' : 'png'}`
}

function buildOutputCanvas() {
  const canvas = getCanvas()
  const scale = outputScale.value / 100
  const out = document.createElement('canvas')
  out.width = Math.max(1, Math.round(canvas.width * scale))
  out.height = Math.max(1, Math.round(canvas.height * scale))
  const ctx = out.getContext('2d')
  if (outputType.value === 'image/jpeg') {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, out.width, out.height)
  }
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(canvas, 0, 0, out.width, out.height)
  return out
}

async function saveImage() {
  const canvas = getCanvas()
  if (!canvas) return
  saving.value = true
  try {
    const out = buildOutputCanvas()
    const blob = await new Promise((resolve) => {
      out.toBlob(resolve, outputType.value, outputType.value === 'image/jpeg' ? jpegQuality.value : undefined)
    })
    if (!blob) throw new Error('导出失败，可能是图片跨域限制')
    const file = new File([blob], outputFileName(), { type: outputType.value })
    emit('saved', { file, width: out.width, height: out.height })
    visible.value = false
  } catch (err) {
    ElMessage.error(err.message || '保存失败')
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.mask-editor {
  display: grid;
  grid-template-columns: 252px minmax(0, 1fr);
  gap: 16px;
  min-height: 560px;
}

.mask-tools {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 14px;
  border: 1px solid #dbe3ee;
  border-radius: 8px;
  background: #f8fafc;
}

.tool-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.tool-row :deep(.el-button) {
  width: 38px;
  height: 38px;
  padding: 0;
}

.bottom-actions {
  margin-top: auto;
}

.control-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.control-label {
  font-size: 12px;
  color: #64748b;
}

.color-line {
  display: flex;
  align-items: center;
  gap: 8px;
}

.color-swatch {
  width: 26px;
  height: 26px;
  border: 2px solid #e2e8f0;
  border-radius: 50%;
  cursor: pointer;
}

.color-swatch.active {
  border-color: #2563eb;
  box-shadow: 0 0 0 2px rgba(37, 99, 235, .16);
}

.mask-stage {
  min-width: 0;
  padding: 16px;
  border: 1px solid #dbe3ee;
  border-radius: 8px;
  background:
    linear-gradient(45deg, #eef2f7 25%, transparent 25%),
    linear-gradient(-45deg, #eef2f7 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #eef2f7 75%),
    linear-gradient(-45deg, transparent 75%, #eef2f7 75%);
  background-position: 0 0, 0 10px, 10px -10px, -10px 0;
  background-size: 20px 20px;
}

.canvas-scroll {
  width: 100%;
  height: 100%;
  max-height: calc(100vh - 240px);
  overflow: auto;
  display: flex;
  align-items: center;
  justify-content: center;
}

.canvas-scroll--loading {
  visibility: hidden;
  pointer-events: none;
}

.canvas-wrap {
  line-height: 0;
}

.canvas-wrap canvas {
  display: block;
  max-width: none;
  border-radius: 6px;
  box-shadow: 0 18px 50px rgba(15, 23, 42, .22);
  cursor: crosshair;
  touch-action: none;
  background: #fff;
}

.canvas-wrap.brushing canvas {
  cursor: cell;
}

.stage-state {
  min-height: 360px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #64748b;
}

.error-state {
  color: #dc2626;
}

.image-size {
  margin-right: auto;
  color: #64748b;
  font-size: 12px;
}

@media (max-width: 860px) {
  .mask-editor {
    grid-template-columns: 1fr;
  }

  .mask-tools {
    order: 2;
  }

  .mask-stage {
    order: 1;
    min-height: 320px;
  }
}
</style>
