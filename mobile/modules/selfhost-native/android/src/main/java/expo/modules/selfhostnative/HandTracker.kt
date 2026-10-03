package expo.modules.selfhostnative

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Matrix
import android.hardware.display.DisplayManager
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Size
import android.view.Surface
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.UseCase
import androidx.camera.core.resolutionselector.AspectRatioStrategy
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import com.google.mediapipe.framework.image.BitmapImageBuilder
import com.google.mediapipe.tasks.core.BaseOptions
import com.google.mediapipe.tasks.core.Delegate
import com.google.mediapipe.tasks.vision.core.RunningMode
import com.google.mediapipe.tasks.vision.handlandmarker.HandLandmarker
import com.google.mediapipe.tasks.vision.handlandmarker.HandLandmarkerResult
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * The car mode's eyes: the front camera, read by MediaPipe's hand landmarker on the phone itself (the model is in this
 * module's assets, nothing is sent anywhere). Each analysed frame goes to [Listener.onFrame] as the 21 points of every
 * hand seen, in the picture as a mirror shows it (upright whatever way the phone is turned, and flipped left to right so
 * a hand moving to the driver's right moves right in the picture). What the gestures are is decided in JavaScript
 * (services/gestureRecognizer.ts).
 *
 * One camera, so one tracker: everything about binding runs on the main thread, the analysis on a thread of its own per
 * session. A session that was stopped drops whatever its camera or its landmarker still hands over afterwards.
 *
 * The camera is tied to the activity's lifecycle: when the app leaves the screen Android closes the camera, and it
 * comes back with the app. JavaScript also stops the tracker then (see hooks/useHandGestureDetection.ts).
 */
object HandTracker {
  interface Listener {
    fun onFrame(frame: Map<String, Any?>)
    /** "running", "stopped", or "error" with a sentence. */
    fun onState(state: String, error: String?)
  }

  private const val MODEL = "hand_landmarker.task"
  private const val MIN_FPS = 5
  private const val MAX_FPS = 30
  /** What the landmarker needs: small frames are faster and see a hand at arm's length just as well. */
  private val ANALYSIS_SIZE = Size(640, 480)

  private class Session(val id: Int, val context: Context, val executor: ExecutorService) {
    /** Created on the analysis thread at the first frame (loading the model takes a moment), closed there too. */
    var landmarker: HandLandmarker? = null
    @Volatile var closed = false
    @Volatile var intervalMs = 1000L / 24
    var lastFrameAt = 0L
    var lastTimestamp = 0L
    /** The size of the upright picture the landmarker saw, sent with each frame so the points can be drawn over the preview. */
    @Volatile var frameWidth = 0
    @Volatile var frameHeight = 0
  }

  private val main = Handler(Looper.getMainLooper())
  @Volatile private var listener: Listener? = null
  private var session: Session? = null
  private var sessions = 0
  private var owner: LifecycleOwner? = null
  private var provider: ProcessCameraProvider? = null
  private var analysis: ImageAnalysis? = null
  private var preview: Preview? = null
  private var previewSurface: Preview.SurfaceProvider? = null
  private var displayListener: DisplayManager.DisplayListener? = null

  /** Starts the front camera and the landmarker at about [fps] frames a second; a tracker already running just takes the new rate. */
  fun start(context: Context, owner: LifecycleOwner, fps: Int, listener: Listener) {
    main.post {
      this.listener = listener
      val interval = 1000L / fps.coerceIn(MIN_FPS, MAX_FPS)
      val current = session
      if (current != null && this.owner === owner) {
        current.intervalMs = interval
        listener.onState("running", null)
        return@post
      }
      stopNow(report = false)
      val app = context.applicationContext
      val next = Session(++sessions, app, Executors.newSingleThreadExecutor { runnable -> Thread(runnable, "hand-tracker") })
      next.intervalMs = interval
      session = next
      this.owner = owner
      val future = ProcessCameraProvider.getInstance(app)
      future.addListener({
        if (session !== next) return@addListener
        try {
          provider = future.get()
          if (provider?.hasCamera(CameraSelector.DEFAULT_FRONT_CAMERA) != true) {
            fail(next, "Pas de caméra frontale sur ce téléphone")
            return@addListener
          }
          bind(next)
          watchRotation(app)
          listener.onState("running", null)
        } catch (e: Exception) {
          fail(next, "Caméra indisponible : ${e.message ?: e.javaClass.simpleName}")
        }
      }, ContextCompat.getMainExecutor(app))
    }
  }

  fun stop() {
    main.post { stopNow(report = true) }
  }

  /** The test mode's picture of the camera (HandCameraPreview): the camera restarts with it added, or without it. */
  fun attachPreview(surface: Preview.SurfaceProvider) {
    main.post {
      previewSurface = surface
      session?.let { if (provider != null) rebind(it) }
    }
  }

  fun detachPreview(surface: Preview.SurfaceProvider) {
    main.post {
      if (previewSurface !== surface) return@post
      previewSurface = null
      session?.let { if (provider != null) rebind(it) }
    }
  }

  // --- Main thread ---

  private fun rebind(session: Session) {
    try {
      bind(session)
    } catch (e: Exception) {
      fail(session, "Caméra indisponible : ${e.message ?: e.javaClass.simpleName}")
    }
  }

  private fun bind(session: Session) {
    val provider = provider ?: return
    val owner = owner ?: return
    val rotation = displayRotation(session.context)
    val selector = ResolutionSelector.Builder()
      // The preview and the analysis share one shape, so the points drawn over the picture fall where the hand is.
      .setAspectRatioStrategy(AspectRatioStrategy.RATIO_4_3_FALLBACK_AUTO_STRATEGY)
      .setResolutionStrategy(ResolutionStrategy(ANALYSIS_SIZE, ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER))
      .build()
    val nextAnalysis = ImageAnalysis.Builder()
      .setResolutionSelector(selector)
      .setTargetRotation(rotation)
      // A slow frame is dropped rather than queued: the gestures want the hand as it is now.
      .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
      .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_RGBA_8888)
      .build()
    nextAnalysis.setAnalyzer(session.executor) { image -> analyze(session, image) }
    val useCases = mutableListOf<UseCase>(nextAnalysis)
    val surface = previewSurface
    val nextPreview = if (surface != null) {
      Preview.Builder()
        .setResolutionSelector(ResolutionSelector.Builder().setAspectRatioStrategy(AspectRatioStrategy.RATIO_4_3_FALLBACK_AUTO_STRATEGY).build())
        .setTargetRotation(rotation)
        .build()
        .also {
          it.setSurfaceProvider(surface)
          useCases.add(it)
        }
    } else null
    provider.unbindAll()
    analysis?.clearAnalyzer()
    analysis = nextAnalysis
    preview = nextPreview
    provider.bindToLifecycle(owner, CameraSelector.DEFAULT_FRONT_CAMERA, *useCases.toTypedArray())
  }

  private fun stopNow(report: Boolean) {
    val ending = session ?: return
    session = null
    ending.closed = true
    try {
      provider?.unbindAll()
    } catch (e: Exception) {
      // The camera service went away: nothing left bound.
    }
    analysis?.clearAnalyzer()
    analysis = null
    preview = null
    owner = null
    unwatchRotation(ending.context)
    // The landmarker is closed on its own thread, after any frame it is still working on.
    ending.executor.execute {
      try {
        ending.landmarker?.close()
      } catch (e: Exception) {
        // Already gone.
      }
      ending.landmarker = null
    }
    ending.executor.shutdown()
    if (report) listener?.onState("stopped", null)
  }

  private fun fail(session: Session, message: String) {
    main.post {
      if (this.session !== session) return@post
      stopNow(report = false)
      listener?.onState("error", message)
    }
  }

  /** In landscape the frames must be turned the other way: the analysis follows the screen as it turns. */
  private fun watchRotation(context: Context) {
    val displays = context.getSystemService(Context.DISPLAY_SERVICE) as? DisplayManager ?: return
    unwatchRotation(context)
    val watcher = object : DisplayManager.DisplayListener {
      override fun onDisplayAdded(displayId: Int) {}
      override fun onDisplayRemoved(displayId: Int) {}
      override fun onDisplayChanged(displayId: Int) {
        val rotation = displayRotation(context)
        analysis?.targetRotation = rotation
        preview?.targetRotation = rotation
      }
    }
    displays.registerDisplayListener(watcher, main)
    displayListener = watcher
  }

  private fun unwatchRotation(context: Context) {
    val watcher = displayListener ?: return
    displayListener = null
    (context.getSystemService(Context.DISPLAY_SERVICE) as? DisplayManager)?.unregisterDisplayListener(watcher)
  }

  private fun displayRotation(context: Context): Int {
    val displays = context.getSystemService(Context.DISPLAY_SERVICE) as? DisplayManager
    return displays?.getDisplay(android.view.Display.DEFAULT_DISPLAY)?.rotation ?: Surface.ROTATION_0
  }

  // --- Analysis thread ---

  private fun analyze(session: Session, image: ImageProxy) {
    try {
      if (session.closed) return
      val now = SystemClock.uptimeMillis()
      if (now - session.lastFrameAt < session.intervalMs) return
      session.lastFrameAt = now
      val landmarker = session.landmarker ?: createLandmarker(session).also { session.landmarker = it }
      val source = image.toBitmap()
      val matrix = Matrix().apply {
        postRotate(image.imageInfo.rotationDegrees.toFloat())
        // Mirrored, as the front camera's preview and a mirror show it.
        postScale(-1f, 1f)
      }
      val upright = Bitmap.createBitmap(source, 0, 0, source.width, source.height, matrix, true)
      if (upright !== source) source.recycle()
      session.frameWidth = upright.width
      session.frameHeight = upright.height
      // The landmarker wants timestamps that only ever grow; uptime does, and gives the processing time back.
      val timestamp = maxOf(now, session.lastTimestamp + 1)
      session.lastTimestamp = timestamp
      landmarker.detectAsync(BitmapImageBuilder(upright).build(), timestamp)
    } catch (e: Exception) {
      fail(session, "Analyse impossible : ${e.message ?: e.javaClass.simpleName}")
    } finally {
      image.close()
    }
  }

  private fun createLandmarker(session: Session): HandLandmarker {
    val options = HandLandmarker.HandLandmarkerOptions.builder()
      // Read into memory here: the model inside the APK may be compressed, which the landmarker cannot open in place.
      .setBaseOptions(BaseOptions.builder().setModelAssetBuffer(readModel(session.context)).setDelegate(Delegate.CPU).build())
      .setRunningMode(RunningMode.LIVE_STREAM)
      // Two, so a passenger's hand does not hide the driver's; JavaScript keeps following one of them.
      .setNumHands(2)
      .setMinHandDetectionConfidence(0.5f)
      .setMinHandPresenceConfidence(0.5f)
      .setMinTrackingConfidence(0.5f)
      .setResultListener { result, _ -> deliver(session, result) }
      .setErrorListener { error -> fail(session, "Analyse impossible : ${error.message ?: error.javaClass.simpleName}") }
      .build()
    return HandLandmarker.createFromOptions(session.context, options)
  }

  private fun readModel(context: Context): ByteBuffer {
    val bytes = context.assets.open(MODEL).use { it.readBytes() }
    return ByteBuffer.allocateDirect(bytes.size).order(ByteOrder.nativeOrder()).apply {
      put(bytes)
      rewind()
    }
  }

  /** On the landmarker's own thread. */
  private fun deliver(session: Session, result: HandLandmarkerResult) {
    if (session.closed) return
    val hands = ArrayList<Map<String, Any?>>()
    result.landmarks().forEachIndexed { index, points ->
      val flat = ArrayList<Double>(points.size * 3)
      for (point in points) {
        flat.add(point.x().toDouble())
        flat.add(point.y().toDouble())
        flat.add(point.z().toDouble())
      }
      val handedness = result.handedness().getOrNull(index)?.firstOrNull()
      hands.add(
        mapOf(
          "score" to (handedness?.score()?.toDouble() ?: 0.0),
          "side" to (handedness?.categoryName() ?: ""),
          "points" to flat
        )
      )
    }
    val timestamp = result.timestampMs()
    listener?.onFrame(
      mapOf(
        "t" to timestamp.toDouble(),
        "ms" to (SystemClock.uptimeMillis() - timestamp).toDouble(),
        "width" to session.frameWidth,
        "height" to session.frameHeight,
        "hands" to hands
      )
    )
  }
}
