// Optional presentation layer only. Audio, conversation and grounding stay on
// the original video/transport. The key color matches Tavus's linked sample.
const vertexSource = `
attribute vec2 a_position;
varying vec2 v_uv;
void main() {
  v_uv = (a_position + 1.0) * 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;
const fragmentSource = `
precision mediump float;
uniform sampler2D u_video;
varying vec2 v_uv;
void main() {
  vec4 pixel = texture2D(u_video, v_uv);
  vec3 key = vec3(0.0, 1.0, 155.0 / 255.0);
  float alpha = smoothstep(0.08, 0.32, distance(pixel.rgb, key));
  // Remove the key contribution at feathered edges, then premultiply for the
  // browser compositor. This avoids a green fringe over the store background.
  vec3 foreground = clamp((pixel.rgb - key * (1.0 - alpha)) / max(alpha, 0.001), 0.0, 1.0);
  gl_FragColor = vec4(foreground * alpha, alpha) * pixel.a;
}`;

/** A replaceable chroma-key surface; does not own or stop its source tracks. */
export class GreenscreenSurface {
  private readonly gl: WebGLRenderingContext;
  private program?: WebGLProgram;
  private buffer?: WebGLBuffer;
  private texture?: WebGLTexture;
  private disposed = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false });
    if (!gl) throw new Error('Background presentation unavailable');
    this.gl = gl;
    const shaders: WebGLShader[] = [];
    try {
      const compile = (kind: number, source: string) => {
        const shader = gl.createShader(kind);
        if (!shader) throw new Error('Background presentation unavailable');
        shaders.push(shader); gl.shaderSource(shader, source); gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error('Background presentation unavailable');
        return shader;
      };
      const vertex = compile(gl.VERTEX_SHADER, vertexSource), fragment = compile(gl.FRAGMENT_SHADER, fragmentSource);
      this.program = gl.createProgram() ?? undefined;
      this.buffer = gl.createBuffer() ?? undefined;
      this.texture = gl.createTexture() ?? undefined;
      if (!this.program || !this.buffer || !this.texture) throw new Error('Background presentation unavailable');
      gl.attachShader(this.program, vertex); gl.attachShader(this.program, fragment); gl.linkProgram(this.program);
      if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) throw new Error('Background presentation unavailable');
      gl.useProgram(this.program);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const position = gl.getAttribLocation(this.program, 'a_position');
      gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.uniform1i(gl.getUniformLocation(this.program, 'u_video'), 0);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.clearColor(0, 0, 0, 0);
    } catch (error) { this.dispose(); throw error; }
    finally { for (const shader of shaders) gl.deleteShader(shader); }
  }

  draw(source: TexImageSource, width: number, height: number): void {
    const gl = this.gl;
    if (this.disposed || gl.isContextLost() || !Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) throw new Error('Background presentation unavailable');
    // The panel is small; cap GPU work while preserving aspect ratio.
    const scale = Math.min(1, 1280 / width, 1280 / height);
    const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    gl.viewport(0, 0, w, h); gl.useProgram(this.program!);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texture!);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.clear(gl.COLOR_BUFFER_BIT); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (gl.getError() !== gl.NO_ERROR) throw new Error('Background presentation unavailable');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.texture) this.gl.deleteTexture(this.texture);
    if (this.buffer) this.gl.deleteBuffer(this.buffer);
    if (this.program) this.gl.deleteProgram(this.program);
    this.texture = undefined; this.buffer = undefined; this.program = undefined;
  }
}

export interface GreenscreenRenderer { dispose(): void }

/** Retains normal video until the first keyed frame; fails back to it on error. */
export function createGreenscreenRenderer(video: HTMLVideoElement, canvas: HTMLCanvasElement,
  options: { onReady(): void; onFallback(): void }): GreenscreenRenderer {
  let surface: GreenscreenSurface | undefined;
  let stopped = false, ready = false;
  let frame: number | undefined, videoFrame: number | undefined;
  const dispose = () => {
    if (stopped) return;
    stopped = true;
    if (frame !== undefined) cancelAnimationFrame(frame);
    if (videoFrame !== undefined) video.cancelVideoFrameCallback(videoFrame);
    canvas.removeEventListener('webglcontextlost', lost);
    surface?.dispose(); surface = undefined;
  };
  const fallback = () => { if (!stopped) { dispose(); options.onFallback(); } };
  const lost = (event: Event) => { event.preventDefault(); fallback(); };
  const render = () => {
    if (stopped) return;
    try {
      if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
        surface!.draw(video, video.videoWidth, video.videoHeight);
        if (!ready) { ready = true; options.onReady(); }
      }
      if (typeof video.requestVideoFrameCallback === 'function') videoFrame = video.requestVideoFrameCallback(render);
      else frame = requestAnimationFrame(render);
    } catch { fallback(); }
  };
  canvas.addEventListener('webglcontextlost', lost);
  try { surface = new GreenscreenSurface(canvas); render(); }
  catch { fallback(); }
  return { dispose };
}
