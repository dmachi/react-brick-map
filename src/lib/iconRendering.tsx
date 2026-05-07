import { Image as KonvaImage, Path, Text } from 'react-konva';
import type { IconSpec } from './types';
import { isImageIcon } from './visualControls';

let textMeasureContext: CanvasRenderingContext2D | null | undefined;

function measureTextWidth(text: string, fontSize: number): number {
  if (typeof document === 'undefined') {
    return Math.max(fontSize * 1.2, text.length * fontSize * 0.62);
  }

  if (textMeasureContext === undefined) {
    const canvas = document.createElement('canvas');
    textMeasureContext = canvas.getContext('2d');
  }

  if (!textMeasureContext) {
    return Math.max(fontSize * 1.2, text.length * fontSize * 0.62);
  }

  textMeasureContext.font = `${fontSize}px sans-serif`;
  return Math.max(fontSize * 1.2, textMeasureContext.measureText(text).width + fontSize * 0.35);
}

/**
 * Renders a Konva node for an `IconSpec` at the given plan/screen-space point.
 *
 * @param icon        - Resolved `IconSpec` (text, svg-path, or image).
 * @param x           - Centre X in the current coordinate space.
 * @param y           - Centre Y in the current coordinate space.
 * @param scale       - Current viewport scale (used to keep sizes consistent).
 * @param fallbackColor - Used as fill for text and svg-path icons when no explicit
 *                        fill is provided by the spec itself.
 * @param iconImages  - Map of loaded `HTMLImageElement` objects keyed by URL.
 *                      Pass the same map that is populated by the image-preload effect
 *                      in each renderer.
 */
export function renderIconAt(
  icon: IconSpec | undefined,
  x: number,
  y: number,
  scale: number,
  fallbackColor: string,
  iconImages: Record<string, HTMLImageElement>,
) {
  if (!icon) {
    return null;
  }

  if (icon.kind === 'text') {
    const fontSize = 6 / scale;
    const textHalfWidth = measureTextWidth(icon.text, fontSize) / 2;
    return (
      <Text
        x={x}
        y={y}
        text={icon.text}
        fontSize={fontSize}
        fill={fallbackColor}
        offsetX={textHalfWidth}
        offsetY={fontSize / 2}
        wrap="none"
      />
    );
  }

  if (icon.kind === 'svg-path') {
    const widthPx = (icon.width ?? 10) / scale;
    const heightPx = (icon.height ?? 10) / scale;
    const viewBoxWidth = icon.viewBoxWidth ?? 24;
    const viewBoxHeight = icon.viewBoxHeight ?? 24;
    return (
      <Path
        data={icon.path}
        x={x - widthPx / 2}
        y={y - heightPx / 2}
        scaleX={widthPx / viewBoxWidth}
        scaleY={heightPx / viewBoxHeight}
        fill={icon.fill ?? fallbackColor}
        stroke={icon.stroke}
        strokeWidth={icon.strokeWidth != null ? icon.strokeWidth / scale : undefined}
      />
    );
  }

  if (isImageIcon(icon)) {
    const image = iconImages[icon.url];
    if (!image) {
      return null;
    }
    const widthPx = (icon.width ?? 14) / scale;
    const heightPx = (icon.height ?? 14) / scale;
    return (
      <KonvaImage
        image={image}
        x={x - widthPx / 2}
        y={y - heightPx / 2}
        width={widthPx}
        height={heightPx}
      />
    );
  }

  return null;
}
