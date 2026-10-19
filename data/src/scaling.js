// Smooth shrinking axes while preserving nearest-neighbor enlargement.
export const defaultScalingShader = {
    shader: {
        type: "text",
        value: 'shaders = 1\nshader0 = "adaptive-scaling.glsl"\nfilter_linear0 = true\n'
    },
    resources: [{
        name: "adaptive-scaling.glsl",
        type: "text",
        value: `#if defined(VERTEX)
attribute vec4 VertexCoord;
attribute vec2 TexCoord;
uniform mat4 MVPMatrix;
varying vec2 textureCoordinate;
void main() {
    gl_Position = MVPMatrix * VertexCoord;
    textureCoordinate = TexCoord;
}
#elif defined(FRAGMENT)
#ifdef GL_ES
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
#endif
uniform sampler2D Texture;
uniform vec2 InputSize;
uniform vec2 TextureSize;
uniform vec2 OutputSize;
uniform int Rotation;
varying vec2 textureCoordinate;
void main() {
    vec2 pixel = textureCoordinate * TextureSize;
    vec2 nearest = floor(pixel) + 0.5;
    vec2 outputSize = (Rotation == 1 || Rotation == 3) ? OutputSize.yx : OutputSize;
    vec2 coordinate = mix(pixel, nearest, step(InputSize, outputSize));
    gl_FragColor = texture2D(Texture, coordinate / TextureSize);
}
#endif
`
    }]
};
