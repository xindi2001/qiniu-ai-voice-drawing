declare module 'imagetracerjs' {
  interface ImageTracerOptions {
    ltres?: number
    qtres?: number
    pathomit?: number
    colorsampling?: number
    numberofcolors?: number
    strokewidth?: number
    linefilter?: boolean
    scale?: number
    roundcoords?: number | boolean
    rightangleenhance?: boolean
    viewbox?: boolean
    desc?: boolean
  }

  const ImageTracer: {
    imagedataToSVG(imageData: ImageData, options?: ImageTracerOptions): string
  }

  export default ImageTracer
}
