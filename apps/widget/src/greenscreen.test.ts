import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGreenscreenRenderer } from './greenscreen.js';

function fixture() {
  const gl = {
    createShader: vi.fn(() => ({})), shaderSource: vi.fn(), compileShader: vi.fn(), getShaderParameter: vi.fn(() => true), deleteShader: vi.fn(),
    createProgram: vi.fn(() => ({})), createBuffer: vi.fn(() => ({})), createTexture: vi.fn(() => ({})), attachShader: vi.fn(), linkProgram: vi.fn(), getProgramParameter: vi.fn(() => true),
    useProgram: vi.fn(), bindBuffer: vi.fn(), bufferData: vi.fn(), getAttribLocation: vi.fn(() => 0), enableVertexAttribArray: vi.fn(), vertexAttribPointer: vi.fn(),
    activeTexture: vi.fn(), bindTexture: vi.fn(), texParameteri: vi.fn(), uniform1i: vi.fn(), getUniformLocation: vi.fn(() => ({})), pixelStorei: vi.fn(), clearColor: vi.fn(),
    isContextLost: vi.fn(() => false), viewport: vi.fn(), texImage2D: vi.fn(), clear: vi.fn(), drawArrays: vi.fn(), getError: vi.fn(() => 0), NO_ERROR: 0,
    deleteTexture: vi.fn(), deleteBuffer: vi.fn(), deleteProgram: vi.fn(),
  };
  const canvas = Object.assign(new EventTarget(), { width: 0, height: 0, getContext: vi.fn(() => gl) });
  let nextFrame: (() => void) | undefined;
  const video = { readyState: 0, videoWidth: 480, videoHeight: 270,
    requestVideoFrameCallback: vi.fn((callback: () => void) => { nextFrame = callback; return 1; }), cancelVideoFrameCallback: vi.fn(),
  };
  const onReady = vi.fn(), onFallback = vi.fn();
  const create = () => createGreenscreenRenderer(video as unknown as HTMLVideoElement, canvas as unknown as HTMLCanvasElement, { onReady, onFallback });
  return { gl, canvas, video, onReady, onFallback, create, frame: () => nextFrame?.() };
}
afterEach(() => { vi.unstubAllGlobals(); });

describe('optional greenscreen media lifecycle', () => {
  it('keeps original presentation until a frame is available, then disposes every GPU resource and ignores late frames', () => {
    const f = fixture(); const renderer = f.create();
    expect(f.onReady).not.toHaveBeenCalled();
    expect(f.gl.drawArrays).not.toHaveBeenCalled();
    f.video.readyState = 2; f.frame(); f.frame();
    expect(f.onReady).toHaveBeenCalledOnce();
    expect(f.gl.drawArrays).toHaveBeenCalledTimes(2);
    renderer.dispose(); renderer.dispose(); f.frame();
    expect(f.video.cancelVideoFrameCallback).toHaveBeenCalledOnce();
    expect(f.gl.deleteProgram).toHaveBeenCalledOnce();
    expect(f.gl.deleteBuffer).toHaveBeenCalledOnce();
    expect(f.gl.deleteTexture).toHaveBeenCalledOnce();
    expect(f.gl.drawArrays).toHaveBeenCalledTimes(2);
    expect(f.onFallback).not.toHaveBeenCalled();
  });

  it('fails back without frame scheduling when WebGL is unavailable', () => {
    const f = fixture(); f.canvas.getContext.mockReturnValue(null as unknown as typeof f.gl);
    const renderer = f.create();
    expect(f.onFallback).toHaveBeenCalledOnce();
    expect(f.video.requestVideoFrameCallback).not.toHaveBeenCalled();
    expect(f.onReady).not.toHaveBeenCalled(); renderer.dispose();
  });

  it.each(['context-loss', 'texture-error', 'gpu-error'] as const)('restores original presentation on %s and stops rendering', failure => {
    const f = fixture(); f.video.readyState = 2; f.create();
    expect(f.onReady).toHaveBeenCalledOnce();
    if (failure === 'context-loss') f.canvas.dispatchEvent(new Event('webglcontextlost'));
    else {
      if (failure === 'texture-error') f.gl.texImage2D.mockImplementation(() => { throw new Error('Synthetic source unavailable'); });
      else f.gl.getError.mockReturnValue(1);
      f.frame();
    }
    const draws = f.gl.drawArrays.mock.calls.length;
    f.frame();
    expect(f.onFallback).toHaveBeenCalledOnce();
    expect(f.gl.drawArrays).toHaveBeenCalledTimes(draws);
    expect(f.gl.deleteTexture).toHaveBeenCalledOnce();
  });

  it('uses and cancels the animation-frame fallback on browsers without video frame callbacks', () => {
    const f = fixture();
    Object.assign(f.video, { requestVideoFrameCallback: undefined });
    const schedule = vi.fn(() => 9), cancel = vi.fn();
    vi.stubGlobal('requestAnimationFrame', schedule); vi.stubGlobal('cancelAnimationFrame', cancel);
    const renderer = f.create();
    expect(schedule).toHaveBeenCalledOnce();
    renderer.dispose();
    expect(cancel).toHaveBeenCalledExactlyOnceWith(9);
  });
});
