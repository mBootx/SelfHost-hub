package expo.modules.selfhostnative

import android.content.Context
import androidx.camera.view.PreviewView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView

/**
 * What the front camera sees, for the car mode's test mode: the hand tracker adds it to the camera while this view is on
 * screen (see HandTracker.attachPreview). Shown whole (letterboxed), mirrored like the points the tracker reports, so the
 * points JavaScript draws over it land on the hand.
 */
class HandCameraPreview(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val previewView = PreviewView(context).apply {
    // A TextureView: it sits in the React Native view tree like any other view (a SurfaceView punches through it).
    implementationMode = PreviewView.ImplementationMode.COMPATIBLE
    scaleType = PreviewView.ScaleType.FIT_CENTER
  }

  init {
    addView(previewView)
  }

  // React Native sizes this view; the camera's view inside is laid out here, which React Native would not do.
  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    val width = right - left
    val height = bottom - top
    previewView.measure(MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY))
    previewView.layout(0, 0, width, height)
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    HandTracker.attachPreview(previewView.surfaceProvider)
  }

  override fun onDetachedFromWindow() {
    HandTracker.detachPreview(previewView.surfaceProvider)
    super.onDetachedFromWindow()
  }
}
