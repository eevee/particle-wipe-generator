"use strict";
const tau = Math.PI * 2;

function range(lo, hi, step) {
    if (step === undefined) {
        step = 1;
    }
    if (hi === undefined) {
        hi = lo;
        lo = 0;
    }

    return {
        lo: lo,
        hi: hi,
        step: step,
        pending: lo,
        next: function() {
            if (this.pending >= this.hi) {
                return { done: true };
            }
            const value = this.pending;
            this.pending += this.step;
            return {
                done: false,
                value: value,
            };
        },
        [Symbol.iterator]: function() {
            return this;
        },
    }
}

// WEBGL HELPER STUFF ----------------------------------------------------------

const vertex_shader_source = `
    // an attribute will receive data from a buffer
    attribute vec4 a_position;

    varying vec2 tex_coords;
     
    // all shaders have a main function
    void main() {
        tex_coords = vec2(a_position.x, 1.0 - a_position.y);
     
        // gl_Position is a special variable a vertex shader
        // is responsible for setting
        gl_Position = vec4(a_position.xy * 2.0 - 1.0, 0.0, 1.0);
    }
`;

const fragment_shader_source = `
    precision mediump float;
     
    uniform sampler2D mask;
    uniform sampler2D before;
    uniform sampler2D after;
    uniform vec4 halo_color;
    uniform float t;
    uniform float ramp;

    varying vec2 tex_coords;

    vec4 alpha_composite(vec4 top, vec4 bottom) {
        float alpha = top.a + bottom.a * (1.0 - top.a);
        return vec4((top.rgb * top.a + bottom.rgb * (bottom.a * (1.0 - top.a))) / alpha, alpha);
    }

    void main() {
        vec4 before_pixel = texture2D(before, tex_coords);
        vec4 after_pixel = texture2D(after, tex_coords);
        vec4 mask_pixel = texture2D(mask, tex_coords);
        float discriminator = mask_pixel.r + mask_pixel.g / 256.0 + mask_pixel.b / 65536.0;
        float scaled_t = t * (1.0 + ramp * 2.0) - ramp;
        if (halo_color.a == 0.0) {
            float alpha = clamp((scaled_t - discriminator) / ramp + 0.5, 0.0, 1.0);
            after_pixel.a *= alpha;
            gl_FragColor = alpha_composite(after_pixel, before_pixel);
        }
        else {
            // Compute the alpha of the halo such that it's 1.0 when the
            // discriminator matches exactly, and 0.0 just at the end of the ramp
            float alpha = clamp(1.0 - abs(scaled_t - discriminator) / ramp, 0.0, 1.0);

            vec4 halo = vec4(halo_color.rgb, alpha);
            if (scaled_t < discriminator) {
                gl_FragColor = alpha_composite(halo, before_pixel);
            }
            else {
                gl_FragColor = alpha_composite(halo, after_pixel);
            }
        }
    }
`;

class Shader {
    constructor(gl, vertex_source, fragment_source) {
        this.gl = gl;

        let vertex_shader = this._compile_shader(gl, gl.VERTEX_SHADER, vertex_source);
        let fragment_shader = this._compile_shader(gl, gl.FRAGMENT_SHADER, fragment_source);

        let program = gl.createProgram();
        gl.attachShader(program, vertex_shader);
        gl.attachShader(program, fragment_shader);
        gl.linkProgram(program);
        if (! gl.getProgramParameter(program, gl.LINK_STATUS)) {
            console.error(gl.getProgramInfoLog(program));
            gl.deleteProgram(program);
            throw new Error("Failed to link program");
        }

        this.program = program;

        // Snag all the attributes + uniform
        this.attributes = {};
        const attribute_ct = gl.getProgramParameter(program, gl.ACTIVE_ATTRIBUTES);
        for (let i = 0; i < attribute_ct; i++) {
            const info = gl.getActiveAttrib(program, i);
            const loc = gl.getAttribLocation(program, info.name);
            this.attributes[info.name] = {
                index: i,
                name: info.name,
                type: info.type,
                size: info.size,
                loc: loc,
            }
        }

        this.uniforms = {};
        let texture_index = 1;  // reserve slot 0 for fucking around in js-land
        const uniform_ct = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
        for (let i = 0; i < uniform_ct; i++) {
            const info = gl.getActiveUniform(program, i);
            const loc = gl.getUniformLocation(program, info.name);
            this.uniforms[info.name] = {
                index: i,
                name: info.name,
                type: info.type,
                size: info.size,
                loc: loc,
            }

            // Assign a texture index if necessary
            if (info.type === gl.SAMPLER_2D) {
                this.uniforms[info.name].texture_index = texture_index;
                texture_index++;
            }
        }
    }

    _compile_shader(gl, type, source) {
        let shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);

        if (! gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            console.error(gl.getShaderInfoLog(shader));
            gl.deleteShader(shader);
            throw new Error("Failed to compile shader");
        }

        return shader;
    }

    send(name, value) {
        const gl = this.gl;
        let uniform = this.uniforms[name];
        if (! uniform) {
            throw new Error(`No such uniform: ${name}`);
        }

        // FIXME should this actually be done now, or only when we're set as the current shader?
        // FIXME can i even call uniform* if it's not the active shader??
        if (uniform.type === gl.FLOAT) {
            gl.uniform1f(uniform.loc, value);
        }
        else if (uniform.type === gl.FLOAT_VEC4) {
            gl.uniform4f(uniform.loc, ...value);
        }
        else if (uniform.type === gl.SAMPLER_2D) {
            if (value.constructor !== Texture) {
                throw new Error("Expected a Texture");
            }

            gl.activeTexture(gl.TEXTURE0 + uniform.texture_index);
            gl.bindTexture(gl.TEXTURE_2D, value.texture);
            // Use texture 0 for general-purpose...  whatevering
            gl.activeTexture(gl.TEXTURE0);

            gl.uniform1i(uniform.loc, uniform.texture_index);
        }
        else {
            throw new Error("Sorry, don't know how to handle this yet");
        }
    }
}

class Texture {
    constructor(gl, image) {
        const texture = gl.createTexture();
        this.texture = texture;

        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, /* level */ 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
        // Disable mipmaps
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        // Fix wrapping
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        // Semi-automatically detect when a canvas needs reuploading
        if (image.tagName === 'CANVAS') {
            image.addEventListener('_updated', event => {
                gl.bindTexture(gl.TEXTURE_2D, this.texture);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
            });
        }
    }
}


// BASE WIPEPLAYER -------------------------------------------------------------

class WipePlayer {
    constructor(canvas, mask_canvas, before_canvas, after_canvas) {
        this.canvas = canvas;
        this.mask_canvas = mask_canvas;
        this.before_canvas = before_canvas;
        this.after_canvas = after_canvas;

        this.mask_canvas.addEventListener('_updated', e => {
            this.schedule_render();
        });

        this.t = 0;
        this.ramp = 4/256;
        this.duration = 2;

        this.playing = false;
        this.loop = false;

        // Allow subclasses to initialize stuff before we go calling hecka
        // methods on ourselves
        this._init();

        this.play_pause_button = document.getElementById('knob-play');
        this.play_pause_button.addEventListener('click', event => {
            if (this.playing) {
                this.pause();
            }
            else {
                this.play();
            }
        });

        this.time_slider = document.getElementById('knob-progress');
        this.time_slider.addEventListener('input', event => {
            this.pause();
            this.set_time(parseFloat(event.target.value));
        });
        this.time_slider_value = document.createElement('output');
        this.time_slider.parentNode.insertBefore(this.time_slider_value, this.time_slider.nextSibling);
        this.set_time(parseFloat(this.time_slider.value));

        this.duration_slider = document.getElementById('knob-duration');
        this.duration_slider.addEventListener('input', e => {
            this.set_duration(parseInt(e.target.value, 10));
        });
        this.duration_slider_value = document.getElementById('knob-duration-value');
        this.set_duration(parseInt(this.duration_slider.value, 10));

        this.ramp_slider = document.getElementById('knob-ramp');
        this.ramp_slider.addEventListener('input', e => {
            this.set_ramp(parseInt(e.target.value, 10));
        });
        this.ramp_slider_value = document.getElementById('knob-ramp-value');
        this.set_ramp(parseInt(this.ramp_slider.value, 10));

        this.halo_picker = document.getElementById('knob-halo-color');
        this.halo_checkbox = document.getElementById('knob-use-halo');
        this.halo_picker.addEventListener('input', e => {
            if (this.halo_color !== null) {
                this.set_halo(this.halo_picker.value);
            }
        });
        this.halo_checkbox.addEventListener('input', e => {
            this.halo_picker.disabled = ! this.halo_checkbox.checked;
            if (this.halo_checkbox.checked) {
                this.set_halo(this.halo_picker.value);
            }
            else {
                this.set_halo(null);
            }
        });
        // FIXME Can we stop copy/pasting the event handlers
        this.halo_picker.disabled = ! this.halo_checkbox.checked;
        if (this.halo_checkbox.checked) {
            this.set_halo(this.halo_picker.value);
        }
        else {
            this.set_halo(null);
        }

        this.loop_checkbox = document.getElementById('knob-play-loop');
        this.loop_checkbox.addEventListener('input', e => {
            this.loop = e.target.checked;
        });
        this.loop = this.loop_checkbox.checked;
    }

    _init() {
    }

    play() {
        if (this.playing)
            return;

        this.playing = true;
        this.last_timestamp = performance.now();
        window.requestAnimationFrame(this.render_loop.bind(this));

        if (this.t === 1) {
            this.set_time(0);
        }

        this.play_pause_button.textContent = '▮▮';
    }

    pause() {
        this.playing = false;

        this.play_pause_button.textContent = '▶️';
    }

    set_time(t) {
        this.t = t;
        this.schedule_render();

        this.time_slider.value = String(t);
        this.time_slider_value.textContent = t.toFixed(3);
    }

    // Sets duration, as a number of 60fps frames
    set_duration(duration) {
        this.duration = duration / 60;
        this.duration_slider_value.textContent = `${(duration / 60).toFixed(3)} seconds / ${duration} frames`;
    }

    // Sets ramp, as an integer from 1 to 256
    set_ramp(ramp) {
        this.ramp = ramp / 256;
        this.schedule_render();

        this.ramp_slider_value.textContent = `${ramp}/256 ≈ ${(ramp / 256).toFixed(3)}`;
    }

    // Sets the halo color, which is an #rrggbb hex string or null, and stores
    // it as an array of three integers up to 255
    set_halo(halo_hex) {
        if (halo_hex == null) {
            this.halo_color = null;
        }
        else {
            this.halo_color = [
                parseInt(halo_hex.substring(1, 3), 16),
                parseInt(halo_hex.substring(3, 5), 16),
                parseInt(halo_hex.substring(5, 7), 16),
            ];
        }
        this.schedule_render();
    }

    schedule_render() {
        if (this.scheduled || this.playing)
            return;

        window.requestAnimationFrame(() => this.render());
    }

    render_loop(timestamp) {
        let dt = (timestamp - this.last_timestamp) / 1000;
        this.last_timestamp = timestamp;
        // Scale the change in time to a change in t
        this.set_time(this.t + dt / this.duration);
        this.render();

        if (this.t >= 1) {
            if (this.loop) {
                this.set_time(0);
            }
            else {
                this.set_time(1);
                this.pause();
                return;
            }
        }

        if (this.playing) {
            window.requestAnimationFrame(this.render_loop.bind(this));
        }
    }
}


// WEBGL WIPEPLAYER ------------------------------------------------------------

class WipePlayerGL extends WipePlayer {
    _init() {
        let gl = this.canvas.getContext('webgl');
        this.gl = gl;
        this.shader = new Shader(gl, vertex_shader_source, fragment_shader_source);

        // Create the position buffer, which we'll never need to change because
        // it's just a flat rectangle
        let positions = new Float32Array([
            0, 0,
            0, 1,
            1, 0,
            1, 1,
        ]);
        let position_buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, position_buf);
        gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
        // I don't know what this does!
        gl.enableVertexAttribArray(this.shader.attributes['a_position'].loc);
        // Bind the position buffer
        gl.bindBuffer(gl.ARRAY_BUFFER, position_buf);
        gl.vertexAttribPointer(this.shader.attributes['a_position'].loc, 2, gl.FLOAT, false, 0, 0)

        // Wrap the canvases in textures
        this.mask_texture = new Texture(gl, this.mask_canvas);
        this.before_texture = new Texture(gl, this.before_canvas);
        this.after_texture = new Texture(gl, this.after_canvas);

        // Set up some common drawing stuff
        gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
        gl.clearColor(0, 0, 0, 0);

        gl.useProgram(this.shader.program);
        this.shader.send('mask', this.mask_texture);
        this.shader.send('before', this.before_texture);
        this.shader.send('after', this.after_texture);
        //this.shader.send('halo_color', [255/255, 137/255, 178/255, 1]);
    }

    set_time(t) {
        super.set_time(t);
        this.shader.send('t', this.t);
    }

    set_ramp(ramp) {
        super.set_ramp(ramp);
        this.shader.send('ramp', this.ramp);
    }

    set_halo(halo) {
        super.set_halo(halo);

        if (this.halo_color == null) {
            this.shader.send('halo_color', [0, 0, 0, 0]);
        }
        else {
            this.shader.send('halo_color', [
                this.halo_color[0] / 255,
                this.halo_color[1] / 255,
                this.halo_color[2] / 255,
                1,
            ]);
        }
    }

    render() {
        this.scheduled = false;

        const gl = this.gl;
        gl.clear(gl.COLOR_BUFFER_BIT);

        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
}


// CANVAS WIPEPLAYER -----------------------------------------------------------

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function lerp(t, a, b) {
    return (1 - t) * a + t * b;
}

class WipePlayerCanvas extends WipePlayer {
    constructor(...args) {
        super(...args);

        this.ctx = this.canvas.getContext('2d');
        this.mask_ctx = this.mask_canvas.getContext('2d');
    }

    render() {
        const width = this.canvas.width;
        const height = this.canvas.height;
        const t = this.t * (1 + this.ramp * 2) - this.ramp;

        // Draw!  Fill the main canvas with the old image, then mask the new image on top
        let mask_pixels = this.mask_ctx.getImageData(0, 0, width, height);

        const halo_color = [255, 137, 178];

        let out_pixels = this.ctx.getImageData(0, 0, width, height);
        const len = out_pixels.data.length;
        let pixels1 = this.before_canvas.getContext('2d').getImageData(0, 0, width, height);
        let pixels2 = this.after_canvas.getContext('2d').getImageData(0, 0, width, height);

        for (let i = 0; i < len; i += 4) {
            let discriminator = mask_pixels.data[i] / 255;
            let alpha = clamp((t - discriminator) / this.ramp + 0.5, 0, 1);
            // FIXME probably do a real alpha composite, especially for the top (makes less sense for bottom)
            /*
            out_pixels.data[i + 0] = lerp(alpha, pixels1.data[i + 0], pixels2.data[i + 0]);
            out_pixels.data[i + 1] = lerp(alpha, pixels1.data[i + 1], pixels2.data[i + 1]);
            out_pixels.data[i + 2] = lerp(alpha, pixels1.data[i + 2], pixels2.data[i + 2]);
            out_pixels.data[i + 3] = 255;
            continue;
            */

            // FIXME make alpha optional
            // Compute the alpha of the halo such that it's 1.0 when the
            // discriminator matches exactly, and 0.0 just at the end of the ramp
            let halo_alpha = clamp(1.0 - Math.abs(t - discriminator) / this.ramp, 0, 1);

            if (alpha <= 0) {
                // Full before
                out_pixels.data[i + 0] = pixels1.data[i + 0];
                out_pixels.data[i + 1] = pixels1.data[i + 1];
                out_pixels.data[i + 2] = pixels1.data[i + 2];
                out_pixels.data[i + 3] = pixels1.data[i + 3];
            }
            else if (alpha >= 1) {
                // Full after
                out_pixels.data[i + 0] = pixels2.data[i + 0];
                out_pixels.data[i + 1] = pixels2.data[i + 1];
                out_pixels.data[i + 2] = pixels2.data[i + 2];
                out_pixels.data[i + 3] = pixels2.data[i + 3];
            }
            else if (alpha < 0.5) {
                // Before, but with the halo color on top
                out_pixels.data[i + 0] = lerp(halo_alpha, pixels1.data[i + 0], halo_color[0]);
                out_pixels.data[i + 1] = lerp(halo_alpha, pixels1.data[i + 1], halo_color[1]);
                out_pixels.data[i + 2] = lerp(halo_alpha, pixels1.data[i + 2], halo_color[2]);
                out_pixels.data[i + 3] = 255;
            }
            else {
                // After, but with the halo color on top
                out_pixels.data[i + 0] = lerp(halo_alpha, pixels2.data[i + 0], halo_color[0]);
                out_pixels.data[i + 1] = lerp(halo_alpha, pixels2.data[i + 1], halo_color[1]);
                out_pixels.data[i + 2] = lerp(halo_alpha, pixels2.data[i + 2], halo_color[2]);
                out_pixels.data[i + 3] = 255;
            }
        }
        this.ctx.putImageData(out_pixels, 0, 0);
    }
}


// A "pattern" is the order in which the wipe's cells are revealed.  Each cell
// is associated with a "step", which is an integer starting from zero.  The
// maximum step is given by the max_step() method.
// One of the simplest patterns is the "row" pattern, where each row is
// revealed in order; therefore each cell's step is simply its row index, and
// the max step is one less than the number of rows.
// Note that it's possible to query cells OUTSIDE the grid, in which case the
// resulting step might be less than zero or more than the max step.  This can
// happen if the particle may start outside the mask and expand into it.  Only
// the immediate outer border is allowed to be queried this way.
class PatternGenerator {
    constructor(row_ct, column_ct) {
        this.row_ct = row_ct;
        this.column_ct = column_ct;
    }

    get max_step() {
        const max_step = this._get_max_step();
        // Overwrite the getter with a regular property
        Object.defineProperty(this, 'max_step', { value: max_step });
        return max_step;
    }

    _get_max_step() {
        throw new Error("Must define _get_max_step");
    }

    cell(r, c) {
        throw new Error("Must define cell");
    }
}

class RowPattern extends PatternGenerator {
    constructor(row_ct, column_ct, droop) {
        super(row_ct, column_ct);

        this.range = Math.ceil(droop * this.row_ct);
        this.offsets = [];
        for (let c = 0; c < this.column_ct + 2; c++) {
            this.offsets.push(Math.floor(Math.random() * this.range));
        }
    }
    _get_max_step() {
        return this.row_ct - 1 + this.range;
    }
    cell(r, c) {
        return r + this.offsets[c + 1];
    }
}
class ColumnPattern extends PatternGenerator {
    constructor(row_ct, column_ct, droop) {
        super(row_ct, column_ct);

        this.range = Math.ceil(droop * this.column_ct);
        this.offsets = [];
        for (let r = 0; r < this.row_ct + 2; r++) {
            this.offsets.push(Math.floor(Math.random() * this.range));
        }
    }
    _get_max_step() {
        return this.column_ct - 1 + this.range;
    }
    cell(r, c) {
        return c + this.offsets[r + 1];
    }
}
// FIXME support droop i guess?
class DiagonalPattern extends PatternGenerator {
    _get_max_step() {
        return this.row_ct - 1 + this.column_ct - 1;
    }
    cell(r, c) {
        return r + c;
    }
}

// Helper for some of the patterns that come in from both directions at once.
// Given n (say, a row index) and count (say, the number of rows), returns the
// distance from the nearest edge.
function reflect(n, count) {
    const midpoint = count / 2;
    if (n < midpoint) {
        return n;
    }
    else {
        return count - 1 - n;
    }
}
// Largest step you can get by reflecting
// FIXME not sure this is right for reflecting spiral
function reflect_max(count) {
    return Math.floor(count / 2 - 0.5);
}

class RowCurtainPattern extends PatternGenerator {
    _get_max_step() {
        return this.row_ct - 1 + reflect_max(this.column_ct);
    }
    cell(r, c) {
        return r + reflect(c, this.column_ct);
    }
}
class ColumnCurtainPattern extends PatternGenerator {
    _get_max_step() {
        return this.column_ct - 1 + reflect_max(this.row_ct);
    }

    cell(r, c) {
        return c + reflect(r, this.row_ct);
    }
}
// This doesn't entirely make sense, but for the sake of completion...
class DiagonalCurtainPattern extends PatternGenerator {
    _get_max_step() {
        return Math.min(this.row_ct, this.column_ct) - 1;
    }

    cell(r, c) {
        return Math.min(r, c);
    }
}

class RowShutterPattern extends PatternGenerator {
    _get_max_step() {
        return reflect_max(this.row_ct);
    }
    cell(r, c) {
        return reflect(r, this.row_ct);
    }
}
class ColumnShutterPattern extends PatternGenerator {
    _get_max_step() {
        return reflect_max(this.column_ct);
    }

    cell(r, c) {
        return reflect(c, this.column_ct);
    }
}
class MainDiagonalShutterPattern extends PatternGenerator {
    _get_max_step() {
        return reflect_max(this.row_ct + this.column_ct);
    }

    cell(r, c) {
        return reflect(r + c, this.row_ct + this.column_ct);
    }
}

class DiamondPattern extends PatternGenerator {
    _get_max_step() {
        return reflect_max(this.row_ct) + reflect_max(this.column_ct);
    }

    cell(r, c) {
        return reflect(r, this.row_ct) + reflect(c, this.column_ct);
    }
}
class BoxPattern extends PatternGenerator {
    _get_max_step() {
        return Math.min(reflect_max(this.row_ct), reflect_max(this.column_ct));
    }

    cell(r, c) {
        return Math.min(reflect(r, this.row_ct), reflect(c, this.column_ct));
    }
}

class SpiralPattern extends PatternGenerator {
    constructor(row_ct, column_ct, fill_delay, spiral_ct, arm_ct, angle) {
        super(row_ct, column_ct);
        this.fill_delay = fill_delay;
        this.spiral_ct = spiral_ct;
        this.arm_ct = arm_ct;
        this.angle = angle;  // in turns, 0–1!

        // Overall radius of the grid
        // TODO should this be the diagonal?
        this.radius = Math.max(this.row_ct, this.column_ct) / 2;

        // Width of each spiral (i.e. spacing between them), measured in cells
        this.spiral_width = this.radius / this.spiral_ct;

        // Cells spread outwards from the spiral, but the spiral will
        // eventually wrap around again and start spreading cells back inwards.
        // This is the meeting point (in fractions of a spiral) between
        // outwards and inwards growing cells
        this.fill_meet = (1 + 1 / this.fill_delay) / 2;

        // Steps are normally integers, counting each cell that appears in
        // order.  But this relies on a bunch of trig, so the results aren't
        // integers.  Try our best, though, by scaling up by the circumference
        // of a spiral with half the maximum radius.
        this.scale = this.radius / 2 * tau;
    }

    _get_max_step() {
        // The furthest away we can get is along a diagonal
        const dx = this.column_ct / 2 - 1/2;
        const dy = this.row_ct / 2 - 1/2;
        const d = Math.sqrt(dx*dx + dy*dy) / this.spiral_width;

        // The math for which corner has the greatest pixel is a little ugly,
        // so, fuck it; let's just try all four corners and pick the max.  In
        // practice, this is shockingly accurate, usually over by ~1% and very
        // rarely under by less than a percent (usually < 0.1%).
        let base_angle = (Math.atan2(dy, dx) + tau) % (tau / 4);
        const calc = angle => {
            let offset = (angle * this.arm_ct / tau - this.angle + 1) % 1;
            // If the corner we're sampling is past the meet point, we should
            // back up and use the meet point instead, since it's brighter
            let d2 = d;
            if (d < offset) {
                // Ah, my old nemesis, the innermost spiral
                if (d > offset * this.fill_meet) {
                    d2 = offset * this.fill_meet;
                }
            }
            else {
                const rem = (d - offset) % 1;
                if (rem > this.fill_meet) {
                    d2 = d - rem + this.fill_meet;
                }
            }
            return this._calc(d2, angle);
        };
        return Math.max(
            calc(base_angle),
            calc(tau/2 - base_angle),
            calc(base_angle + tau/2),
            calc(tau - base_angle));
    }

    _calc(d, theta) {
        theta = (theta * this.arm_ct + tau * (2 - this.angle)) % tau;
        // How far out spirals start at this angle, in fractions of a spiral (0 to 1)
        const offset = theta / tau;

        let d2 = d - offset;
        // Nearest spiral, and the distance from it
        let nearest_spiral = Math.floor(d2 + 1 - this.fill_meet);
        let dist_to_spiral = Math.abs(nearest_spiral - d2);
        // How far along the spiral this point is, in revolutions
        let t = nearest_spiral + offset;
        // If we're inside the innermost spiral, the distance from here to the
        // center is smaller than the distance between spirals normally is, so
        // adjust accordingly
        if (d < offset) {
            if (d < offset * this.fill_meet) {
                // We're so close to the center that angle is irrelevant
                t = 0;
                dist_to_spiral = d;
            }
            else {
                // Outer spiral is closer than the origin
                dist_to_spiral = offset - d;
            }
        }

        // The spiral itself is the main counter here, and cells between the
        // spiral's arms are filled in outwards, with fill_delay being the time
        // (in full spirals) it takes to spread from one arm to the next
        return this.scale * (t + dist_to_spiral * this.fill_delay);
    }

    cell(r, c) {
        const w = this.spiral_width;

        // Coordinates of this cell's center, in grid cells, relative to center
        const x = (c + 0.5) - (this.column_ct / 2);
        const y = (r + 0.5) - (this.row_ct / 2);
        // Distance this cell is from the center, in spiral widths (which are
        // themselves still measured in grid cells)
        let d = Math.sqrt(x*x + y*y) / w;

        // Flip y because it points down (since this is an image) but
        // Math.atan2 thinks it points up
        return this._calc(d, Math.atan2(-y, x));
    }
}

// FIXME should this try to enforce that cells aren't left to grow until they hit a wall?  or should i make the generator smarter and willing to keep looking (!)
class RandomPattern extends PatternGenerator {
    constructor(...args) {
        super(...args);

        const range = this.max_step;
        this.cells = [];
        for (let r = 0; r < this.row_ct + 2; r++) {
            let row = [];
            for (let c = 0; c < this.column_ct + 2; c++) {
                row.push(Math.floor(Math.random() * range));
            }
            this.cells.push(row);
        }
    }

    _get_max_step() {
        // FIXME probably oughta be configurable and based on the number of cells
        return 16;
    }

    cell(r, c) {
        return this.cells[r + 1][c + 1];
    }
}

class InfectPattern extends PatternGenerator {
    constructor(...args) {
        super(...args);

        // FIXME configurable?
        const density = 1/32;

        // Generate an empty grid
        this.cells = [];
        for (let r = 0; r < this.row_ct + 2; r++) {
            this.cells.push(new Array(this.column_ct + 2));
        }

        // Pick some seed cells
        const cell_ct = this.row_ct * this.column_ct;
        const num_seeds = Math.ceil(density * cell_ct);
        let seen = {};
        let next_round = [];
        for (const i of range(num_seeds)) {
            // FIXME avoid infinite loop here i guess
            let n = Math.floor(Math.random() * cell_ct);
            while (seen[n]) {
                n = Math.floor(Math.random() * cell_ct);
            }
            seen[n] = true;

            const r = Math.floor(n / this.column_ct);
            const c = n % this.column_ct;
            this.cells[r + 1][c + 1] = 0;
            next_round.push([r - 1, c]);
            next_round.push([r + 1, c]);
            next_round.push([r, c - 1]);
            next_round.push([r, c + 1]);
        }
        console.log("seeds:", next_round);

        // Floodfill!
        let step = 1;
        while (next_round.length > 0) {
            console.log("doing step", step);
            let this_round = next_round;
            next_round = [];
            for (const [r, c] of this_round) {
                if (r < -1 || r > this.row_ct || c < -1 || c > this.column_ct) {
                    continue;
                }
                if (this.cells[r + 1][c + 1] !== undefined) {
                    continue;
                }

                this.cells[r + 1][c + 1] = step;
                next_round.push([r - 1, c]);
                next_round.push([r + 1, c]);
                next_round.push([r, c - 1]);
                next_round.push([r, c + 1]);
            }

            step++;
        }

        Object.defineProperty(this, 'max_step', { value: step - 1 });
    }

    _get_max_step() {
        // Not used; calculated dynamically in constructor
        throw new Error("_get_max_step is unused for InfectPattern");
    }

    cell(r, c) {
        return this.cells[r + 1][c + 1];
    }
}

// Wrappers that can apply to any type of generator
class PatternWrapper {
    constructor(pattern) {
        this.wrapped = pattern;
        this.row_ct = pattern.row_ct;
        this.column_ct = pattern.column_ct;
        this.max_step = pattern.max_step;
    }
}
class PatternInterlaced extends PatternWrapper {
    constructor(pattern, stride) {
        super(pattern);
        this.stride = stride;
    }
    cell(r, c) {
        const step = this.wrapped.cell(r, c);
        const stride = this.stride;
        return (
            // Division clusters them together, so the first steps are the
            // first items from each cluster
            Math.floor(step / stride)
            // Each item in a cluster is offset by the total number of steps it
            // takes to run through each cluster once
            + Math.floor(this.max_step / stride) * (step % stride)
            // If the span doesn't evenly divide into clusters, then the last
            // cluster is shorter than the others, so it'll be skipped on later
            // runs; or in other words, earlier runs have a longer stride
            + Math.min(step % stride, (this.max_step + 1) % stride)
        );
    }
}
class PatternReversed extends PatternWrapper {
    cell(r, c) {
        return this.max_step - this.wrapped.cell(r, c);
    }
}
class PatternMirrored extends PatternWrapper {
    cell(r, c) {
        return this.wrapped.cell(r, this.column_ct - c - 1);
    }
}
class PatternFlipped extends PatternWrapper {
    cell(r, c) {
        return this.wrapped.cell(this.row_ct - r - 1, c);
    }
}
class PatternReflected extends PatternWrapper {
    constructor(pattern) {
        super(pattern);
        this.max_step = reflect_max(this.wrapped.max_step + 1);
    }
    cell(r, c) {
        return reflect(this.wrapped.cell(r, c), this.wrapped.max_step + 1);
    }
}




// Note that some of the patterns as exposed in the UI map to several pattern
// generator types, depending on other settings.  This maps UI patterns to the
// controls they rely on, and how those controls affect the choice and
// configuration of generator.
const PATTERN_GENERATORS = {
    // "Wipe" is a straight wipe across in one of the four cardinal directions
    // TODO hmm, arbitrary angle wipes or curtains?
    wipe: {
        extra_controls: ['direction'],
        extra_args: ['droop'],
        generator: {
            row: RowPattern,
            column: ColumnPattern,
            diagonal: DiagonalPattern,
        },
    },
    // "Curtain" expands from two adjacent corners in one of the four cardinal
    // directions; if downwards, it looks like stage curtains closing
    curtain: {
        extra_controls: ['direction'],
        generator: {
            row: RowCurtainPattern,
            column: ColumnCurtainPattern,
            diagonal: DiagonalCurtainPattern,
        },
    },
    // "Shutter" closes from two opposite corners or sides
    shutter: {
        extra_controls: ['direction'],
        generator: {
            row: RowShutterPattern,
            column: ColumnShutterPattern,
            diagonal: MainDiagonalShutterPattern,
            // There is no off-diagonal pattern, since you can just mirror/flip
            // the diagonal one
        },
    },
    // "Diamond" closes from all four corners at once
    diamond: {
        generator: DiamondPattern,
    },
    // "Box" closes from all four edges at once
    box: {
        generator: BoxPattern,
    },
    // "Spiral" is a cool spiral from the center
    spiral: {
        generator: SpiralPattern,
        extra_args: ['fill-delay', 'loops', 'arms', 'angle'],
    },
    // "Random" is, well, random
    random: {
        generator: RandomPattern,
    },
    // "Infect" starts like random, but the cells grow outwards from their
    // starting places
    infect: {
        generator: InfectPattern,
    },
    // TODO pinch?  like, > <
    // TODO sliding in rows from opposite sides
    // TODO radial sweep?
    // TODO random splatters?  not really grid-based at all huh
    // TODO shapes sliding across?  also not really grid-based
}

function generate_cell_pattern(rows, cols, pattern_generator) {
    let pattern = [];
    let step_ct = 0;
    for (let r = 0; r < rows; r++) {
        pattern.push(new Array(cols));
        for (let c = 0; c < cols; c++) {
            let step = pattern_generator(r, c, rows, cols);
            pattern[r][c] = step;
        }
        step_ct = Math.max(step_ct, ...pattern[r]);
    }

    return [pattern, step_ct];
}

const PRESET_PARTICLES = {
    diamond(ctx, w, h) {
        ctx.moveTo(0, h/2);
        ctx.lineTo(w/2, 0);
        ctx.lineTo(w, h/2);
        ctx.lineTo(w/2, h);
    },

    circle(ctx, w, h) {
        ctx.ellipse(w/2, h/2, w/2, h/2, 0, 0, tau);
    },

    // FIXME this is, broken
    heart(ctx, w, h) {
        ctx.moveTo(0, h/2);
        ctx.lineTo(w/2, h);
        ctx.lineTo(w, h/2);
        ctx.arc(w*3/4, h/4, w/4, tau/8, 4*tau/8, true);
        ctx.arc(w/4, h/4, w/4, 7*tau/8, 3*tau/8, true);
    },

    // TODO extend into generic polygon/star?
    star(ctx, w, h) {
        const r = w/2;
        // Ratio of the inner (dimple) radius to the outer radius
        const r2 = r * Math.sqrt((7 - 3 * Math.sqrt(5)) / 2);
        // Surprise!  This vertically centers the star
        const x0 = w/2;
        const y0 = h/2 + r2 / 4;
        for (let i = 0; i < 5; i++) {
            const x = x0 + r * Math.cos(tau * (0.75 + i / 5));
            const y = y0 + r * Math.sin(tau * (0.75 + i / 5));

            if (i === 0) {
                ctx.moveTo(x, y);
            }
            else {
                ctx.lineTo(x, y);
            }

            const x2 = x0 + r2 * Math.cos(tau * (0.85 + i / 5));
            const y2 = y0 + r2 * Math.sin(tau * (0.85 + i / 5));
            ctx.lineTo(x2, y2);
        }
    },

    text(ctx, w, h) {
        // FIXME do this /before/ clearing the canvas, doofus
        const letter = prompt("Enter a character:");
        console.log(letter);
        if (! letter) {
            return;
        }
        ctx.font = `${h * 0.8}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(letter, w/2, h * 3/4, w);
    },

};

function inject_file_support(canvas, callback) {
    const figure = canvas.parentNode;
    if (figure.tagName !== 'FIGURE') {
        throw new Error("Expected a figure container");
    }

    const figcaption = figure.querySelector('figcaption');
    // Wrap the caption in a <p> to enable some flexboxing
    let p = document.createElement('p');
    // XXX hokey
    p.textContent = figcaption.firstChild.textContent;
    figcaption.removeChild(figcaption.firstChild);
    figcaption.insertBefore(p, figcaption.firstChild);

    let uploader = document.createElement('input');
    uploader.type = 'file';
    figcaption.appendChild(uploader);

    let button = document.createElement('button');
    button.textContent = '📂';
    button.addEventListener('click', e => {
        uploader.click();
    });
    figcaption.appendChild(button);

    async function handle_blob(blob) {
        const bitmap = await createImageBitmap(blob);
        callback(bitmap, canvas);
    }

    canvas.addEventListener('dragenter', e => {
        e.stopPropagation();
        e.preventDefault();

        figure.classList.add('drag-hover');
    });
    canvas.addEventListener('dragover', e => {
        e.stopPropagation();
        e.preventDefault();
    });
    canvas.addEventListener('dragleave', e => {
        figure.classList.remove('drag-hover');
    });
    canvas.addEventListener('drop', e => {
        e.stopPropagation();
        e.preventDefault();

        figure.classList.remove('drag-hover');
        console.log(e);
        handle_blob(e.dataTransfer.files[0]);
    });

    uploader.addEventListener('change', e => {
        if (e.target.files[0]) {
            handle_blob(e.target.files[0]);
        }
    });
}

class GeneratorView {
    constructor(container, mask_canvas) {
        this.container = container;

        // Current values of settings in the UI
        this.settings = {};
        // Map of controls, keyed by the names they use in this.settings
        this.controls = {};

        this.particle_canvas = document.getElementById('particle-canvas');
        this.preview_canvas = document.getElementById('preview');
        this.preview_ctx = this.preview_canvas.getContext('2d');

        inject_file_support(this.particle_canvas, (bitmap, canvas) => {
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            let ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        });

        // Bind some required controls
        this.bind_control('control-rows', 'rows');
        this.bind_control('control-cols', 'columns');
        this.bind_control('control-delay', 'delay');
        this.bind_control('control-pattern', 'pattern');
        // And optional ones
        this.bind_control('control-direction', 'direction', true);
        this.bind_control('control-angle', 'angle', true);
        this.bind_control('control-droop', 'droop', true);
        this.bind_control('control-fill-delay', 'fill-delay', true);
        this.bind_control('control-loops', 'loops', true);
        this.bind_control('control-arms', 'arms', true);
        // And generic ones
        // TODO maybe these should be hidden for symmetric ones where they don't apply?
        this.bind_control('control-interlace', 'interlace');
        this.bind_control('control-reflect', 'reflect');
        this.bind_control('control-reverse', 'reverse');
        this.bind_control('control-mirror', 'mirror');
        this.bind_control('control-flip', 'flip');

        // Read in the current values of all the controls
        for (const control_def of Object.values(this.controls)) {
            this.read_control(control_def.control);
        }

        this.update_preview();

        for (const button of document.querySelectorAll('button.control-preset-particle')) {
            button.addEventListener('click', event => {
                const shape = event.target.value;
                this.draw_preset_particle(shape);
            });
        }
        // Diamond is a pretty reasonable default
        this.draw_preset_particle('diamond');

        // And of course, bind the button
        this.generate_button = document.getElementById('control-generate');
        this.generate_button.addEventListener('click', event => {
            generate_particle_wipe_mask(this.particle_canvas, mask_canvas, this.settings.rows, this.settings.columns, this.settings.delay, this.get_generator());
        });

        // TODO finish, this
        //this.generate_button.classList.add('dirty');
    }

    // Register our interest in a control and do some stuff to it
    bind_control(id, attr, is_optional) {
        let control = document.getElementById(id);
        control.setAttribute('data-attr', attr);

        if (control.type === 'range') {
            let label = document.createElement('output');
            label.className = 'range-label';
            control.parentNode.insertBefore(label, control.nextSibling);
        }

        this.controls[attr] = {
            control: control,
            optional: is_optional,
        };

        control.addEventListener('input', event => {
            this.read_control(control);
            this.update_preview();
        });
    }

    // Read a new value from a changed control
    read_control(control) {
        let value = control.value;
        if (control.type === 'range') {
            let label = control.nextSibling;
            label.textContent = value;
            value = parseFloat(value);
        }
        else if (control.type === 'checkbox') {
            value = control.checked;
        }

        const attr = control.getAttribute('data-attr');
        this.settings[attr] = value;

        // If the pattern changed, we need to update the optional controls
        if (attr === 'pattern') {
            const generator_def = PATTERN_GENERATORS[value];
            if (! generator_def) {
                // FIXME better error?
                return;
            }

            for (const control_def of Object.values(this.controls)) {
                if (control_def.optional) {
                    // FIXME going to parent node to hit the label kiiind of sucks
                    control_def.control.parentNode.previousElementSibling.classList.add('hidden');
                }
            }

            for (const control_key of (generator_def.extra_controls || [])) {
                this.controls[control_key].control.parentNode.previousElementSibling.classList.remove('hidden');
            }
            for (const control_key of (generator_def.extra_args || [])) {
                this.controls[control_key].control.parentNode.previousElementSibling.classList.remove('hidden');
            }
        }
    }

    draw_preset_particle(shape) {
        const draw = PRESET_PARTICLES[shape];
        if (! draw) {
            return;
        }

        const ctx = this.particle_canvas.getContext('2d');
        const w = this.particle_canvas.width;
        const h = this.particle_canvas.height;
        ctx.clearRect(0, 0, w, h);
        ctx.beginPath();
        draw(ctx, w, h);
        ctx.closePath();
        ctx.fill();
    }

    get_generator() {
        const pattern_type = this.settings.pattern;
        const generator_def = PATTERN_GENERATORS[pattern_type];
        let generator_tree = generator_def.generator;

        for (const key of generator_def.extra_controls || []) {
            const value = this.settings[key];
            generator_tree = generator_tree[value];
            if (! generator_tree) {
                throw new Error(`Can't find a generator for ${key} = ${value}`);
            }
        }

        let extra_args = [];
        for (const key of generator_def.extra_args || []) {
            const value = this.settings[key];
            extra_args.push(value);
        }

        let generator = new generator_tree(this.settings.rows, this.settings.columns, ...extra_args);

        // Apply wrappers, if appropriate
        // TODO when does interlace apply?
        if (this.settings.interlace > 1) {
            generator = new PatternInterlaced(generator, this.settings.interlace);
        }
        // Note that reflect must happen before reverse, or the steps will be symmetrical and reverse will be lost
        if (this.settings.reflect) {
            generator = new PatternReflected(generator);
        }
        if (this.settings.reverse) {
            generator = new PatternReversed(generator);
        }
        if (this.settings.mirror) {
            generator = new PatternMirrored(generator);
        }
        if (this.settings.flip) {
            generator = new PatternFlipped(generator);
        }

        return generator;
    }

    update_preview() {
        const rows = this.settings.rows;
        const cols = this.settings.columns;

        const generator = this.get_generator();
        const max_step = generator.max_step;

        const width = this.preview_canvas.width;
        const height = this.preview_canvas.height;
        const cell_width = width / cols;
        const cell_height = height / rows;
        let ctx = this.preview_ctx;

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const value = generator.cell(r, c) / max_step;
                if (value > 1) {
                    console.log("warning, exceeded max step!", value * max_step, max_step, r, c);
                }

                ctx.fillStyle = `rgb(${value * 100}%, ${value * 100}%, ${value * 100}%)`;
                ctx.fillRect(Math.floor(cell_width * c), Math.floor(cell_height * r), Math.ceil(cell_width), Math.ceil(cell_height));
            }
        }

        ctx.fillStyle = '#80808020';
        for (let r = 1; r < rows; r++) {
            ctx.fillRect(0, Math.floor(cell_height * r), width, 1);
        }
        for (let c = 1; c < cols; c++) {
            ctx.fillRect(Math.floor(cell_width * c), 0, 1, height);
        }
    }
}

function* trace_line(x0, y0, x1, y1) {
    "use strict";
    let dx = x1 - x0;
    let dy = y1 - y0;

    let a = Math.floor(x0)
    let b = Math.floor(y0)

    if (dx === 0 && dy === 0) {
        // Special case: this is a single pixel
        yield [a, b];
        return;
    }

    // Use a modified Bresenham.  Use mirroring to move everything into the
    // first quadrant, then split it into two octants depending on whether dx
    // or dy increases faster, and call that the main axis.  Track an "error"
    // value, which is the (negative) distance between the ray and the next
    // grid line parallel to the main axis, but scaled up by dx.  Every
    // iteration, we move one cell along the main axis and increase the error
    // value by dy (the ray's slope, scaled up by dx); when it becomes
    // positive, we can subtract dx (1) and move one cell along the minor axis
    // as well.  Since the main axis is the faster one, we'll never traverse
    // more than one cell on the minor axis for one cell on the main axis, and
    // this readily provides every cell the ray hits in order.
    // Based on: http://www.idav.ucdavis.edu/education/GraphicsNotes/Bresenhams-Algorithm/Bresenhams-Algorithm.html

    // Setup: map to the first quadrant.  The "offsets" are the distance
    // between the starting point and the next grid point.
    let step_a = 1;
    let offset_x = 1 - (x0 - a);
    if (dx < 0) {
        dx = -dx;
        step_a = -step_a;
        offset_x = 1 - offset_x;
    }
    // Zero offset means we're on a grid line, so we're actually a full cell
    // away from the next grid line
    if (offset_x === 0) {
        offset_x = 1;
    }

    let step_b = 1;
    let offset_y = 1 - (y0 - b);
    if (dy < 0) {
        dy = -dy;
        step_b = -step_b;
        offset_y = 1 - offset_y;
    }
    if (offset_y === 0) {
        offset_y = 1;
    }

    let err = dy * offset_x - dx * offset_y;

    let min_x = Math.floor(Math.min(x0, x1));
    let max_x = Math.floor(Math.max(x0, x1));
    let min_y = Math.floor(Math.min(y0, y1));
    let max_y = Math.floor(Math.max(y0, y1));

    if (dx > dy) {
        // Main axis is x/a
        while (min_x <= a && a <= max_x && min_y <= b && b <= max_y) {
            yield [a, b];

            if (err > 0) {
                err -= dx;
                b += step_b;
                yield [a, b];
            }
            err += dy;
            a += step_a;
        }
    }
    else {
        err = -err;
        // Main axis is y/b
        while (min_x <= a && a <= max_x && min_y <= b && b <= max_y) {
            yield [a, b];

            if (err > 0) {
                err -= dy;
                a += step_a;
                yield [a, b];
            }
            err += dx;
            b += step_b;
        }
    }
}

// FIXME hey, if they only change the pattern/delay but not the stamp, there's no need to regenerate it...
function generate_particle_wipe_mask(particle_canvas, out_canvas, row_ct, column_ct, delay, generator) {
    "use strict";
    const width = out_canvas.width;
    const height = out_canvas.height;
    const column_width = Math.ceil(width / column_ct);
    const row_height = Math.ceil(height / row_ct);

    const particle_width = particle_canvas.width;
    const particle_height = particle_canvas.height;
    let particle_ctx = particle_canvas.getContext('2d');
    let particle_pixels = particle_ctx.getImageData(0, 0, particle_canvas.width, particle_canvas.height);

    // FIXME show the stamp!!
    // Generate a stamp
    let box_scales = [];
    let max_scale = 0;
    // Center of the stamp
    const mid_x = column_width * 3 / 2;
    const mid_y = row_height * 3 / 2;
    // Center of the particle
    const pcx = particle_width / 2;
    const pcy = particle_height / 2;

    for (let py = 0; py < row_height * 3; py++) {
        let box_scale_row = [];
        box_scales.push(box_scale_row);
        for (let px = 0; px < column_width * 3; px++) {
            // Consider the pixel as having been hit when its center is touched
            const dx = (px + 0.5) - mid_x;
            const dy = (py + 0.5) - mid_y;
            // This is how big the particle would have to be to hit it
            const size_x = Math.abs(dx * 2);
            const size_y = Math.abs(dy * 2);
            // This is the relative size of the particle at that point
            // outer edge to touch the center of this pixel
            const scale = Math.max(size_x / particle_width, size_y / particle_height);

            if (scale === 0) {
                // Special case: this is the exact center of the box, so it's the
                // very first pixel to light.  This math will explode since the
                // distance is zero, but we can call this a scale of zero and
                // continue on.
                box_scale_row.push(0);
                continue;
            }

            // Now find the point at which the expanding particle would touch
            const ix = pcx + dx / scale;
            const iy = pcx + dy / scale;

            let hit_scale = 0;
            for (const [ax, ay] of trace_line(ix, iy, pcx, pcy)) {
                // If the particle is N pixels wide and hits us on its right
                // side, then we start from pixel N, which is actually outside
                // the particle!  So, skip that.
                if (ax >= particle_width || ay >= particle_height)
                    continue;

                const alpha = particle_pixels.data[(ax + ay * particle_width) * 4 + 3];
                // TODO multiply by the alpha of the line?  can we get that?
                if (alpha < 128) {
                    continue;
                }

                // Found a point!  Find the distance from the center to the entry
                // point, and the center to the found point; the ratio of those is
                // how much bigger the particle needs to be for this point to become
                // visible
                const dist_to_entry2 = Math.pow(ix - pcx, 2) + Math.pow(iy - pcy, 2);
                const dist_to_hit2 = Math.pow(ax - pcx, 2) + Math.pow(ay - pcy, 2);
                hit_scale = Math.sqrt(dist_to_entry2 / dist_to_hit2);
                break;
            }

            const necessary_scale = scale * hit_scale;
            box_scale_row.push(necessary_scale);
        }

        if (row_height <= py && py < row_height * 2) {
            max_scale = Math.max(max_scale, ...box_scale_row.slice(column_width, column_width * 2));
        }
    }

    let stamp_canvas = document.createElement('canvas');
    stamp_canvas.width = column_width * 3;
    stamp_canvas.height = row_height * 3;
    let stamp_ctx = stamp_canvas.getContext('2d');
    let stamp_pixels = stamp_ctx.getImageData(0, 0, stamp_canvas.width, stamp_canvas.height);
    let q = 0;
    for (let py = 0; py < row_height * 3; py++) {
        for (let px = 0; px < column_width * 3; px++) {
            const value = box_scales[py][px] / (max_scale * 3) * 255;
            stamp_pixels.data[q] = value;
            q++;
            stamp_pixels.data[q] = value;
            q++;
            stamp_pixels.data[q] = value;
            q++;
            stamp_pixels.data[q] = 255;
            q++;
        }
    }
    stamp_ctx.putImageData(stamp_pixels, 0, 0);
    // FIXME it would be cool to see this somewhere?
    //document.body.appendChild(stamp_canvas);

    // Total time factor, as a multiple of how long a single step takes.
    // If delay is 0, this is 1; if delay is 1, this is the number of steps.
    // (Remember, max_step is when the last step STARTS!)
    // FIXME this is wrong, because cells can overlap!
    const total_time = generator.max_step * delay + 1;
    console.log(max_scale, total_time, generator.max_step, delay);

    /*
    let x_total_time = 0;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const col = Math.floor(x / column_width);
            const row = Math.floor(y / row_height);
            const step = pattern[row][col];
            if (step !== generator.max_step)
                continue;

            console.log("found one with step", step);
            const start_time = (generator.max_step - step) * delay;

            const bx = x % column_width;
            const by = y % row_height;

            let scales = [];
            for (let drow = 0; drow < 3; drow++) {
                const srow = row + drow - 1;
                for (let dcol = 0; dcol < 3; dcol++) {
                    const scol = col + dcol - 1;

                    let scale = box_scales[by + row_height * drow][bx + column_width * dcol];
                    //const scale_step = pattern[srow][scol];
                    const scale_step = pattern_generator(srow, scol, row_ct, column_ct);
                    scale += (scale_step - step) * delay * max_scale;
                    scales.push(scale);
                }
            }
            let scale = Math.min(...scales);

            x_total_time = Math.max(x_total_time, (start_time + scale / max_scale));
        }
    }
    console.log('maximum actual time?', x_total_time);
    */

    let ctx = out_canvas.getContext('2d');
    let pixels = ctx.getImageData(0, 0, width, height);
    let actual_max_step = 0;
    let actual_min_step = 100;

    // FIXME i realize, all of a sudden, that in cases like squares, you likely
    // don't WANT them to keep growing outside their box.  hmm
    // TODO could this part be done with a shader?  it's basically just adding
    // and maxing some pixel values, right?  even a bunch of draw calls, one
    // stamp at a time, might be faster
    // FIXME i think this would be a bit speedier if it worked a cell at a time?
    let i = 0;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const col = Math.floor(x / column_width);
            const row = Math.floor(y / row_height);
            const step = generator.cell(row, col);
            actual_max_step = Math.max(actual_max_step, step);
            actual_min_step = Math.min(actual_min_step, step);

            const start_time = step * delay;

            // FIXME suspect there'll be a problem here with indexing from 0 vs 1
            const bx = x % column_width;
            const by = y % row_height;

            let scales = [];
            let scale_steps = [];
            // FIXME keep looking further until we find a cell whose step is adjacent to ours?
            for (let drow = 0; drow < 3; drow++) {
                // drow/dcol measure where on the /stamp/ we're sampling from,
                // so the actual cell the particle would be expanding from is
                // in the opposite direction.
                // If it's off the edge of the board, skip it
                const srow = row + 1 - drow;
                if (srow < 0 || srow >= row_ct)
                    continue;

                for (let dcol = 0; dcol < 3; dcol++) {
                    const scol = col + 1 - dcol;
                    if (scol < 0 || scol >= column_ct)
                        continue;

                    let scale = box_scales[by + row_height * drow][bx + column_width * dcol];
                    const scale_step = generator.cell(srow, scol);
                    scale += (scale_step - step) * delay * max_scale;
                    scales.push(scale);
                    scale_steps.push(scale_step);
                }
            }
            let scale = Math.min(...scales);
            const time = start_time + scale / max_scale;
            let value = time / total_time;

            value *= 256;
            pixels.data[i + 0] = Math.floor(value);
            value = (value % 1) * 256;
            pixels.data[i + 1] = Math.floor(value);
            value = (value % 1) * 256;
            pixels.data[i + 2] = Math.floor(value);
            pixels.data[i + 3] = 255;
            i += 4;
        }
    }

    console.log("claimed range was", 0, "to", generator.max_step, "but in practice got", actual_min_step, "to", actual_max_step);

    ctx.putImageData(pixels, 0, 0);

    ctx = null;
    out_canvas.dispatchEvent(new Event('_updated'));
}




window.addEventListener('load', init);
function gl_init() {
    let canvas = document.getElementById('canvas');
    let gl = canvas.getContext('webgl');

    if (gl === null) {
        // FIXME fall back to regular canvas
        return;
    }

    // -- Draw i guess --

    let player = new WipePlayerGL(gl, document.getElementById('mask'));

    player.play();
}

function init() {
    "use strict";
    let canvas = document.getElementById('canvas');

    let mask_canvas = document.getElementById('mask-canvas');
    let width = canvas.width;
    let height = canvas.height;

    let mask_ctx = mask_canvas.getContext('2d');

    // Populate the mask
    // TODO probably ensure the mask is the same size or whatever
    let particle = document.getElementById('particle');

    let view = new GeneratorView(document.querySelector('#generator .particle'), mask_canvas);

    // Deal with the playback canvases
    function file_handler(bitmap, canvas) {
        let ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        canvas.dispatchEvent(new Event('_updated'));
        player.schedule_render();
    }

    let before_canvas = document.getElementById('before-canvas');
    inject_file_support(before_canvas, file_handler);
    let before_control = document.getElementById('before-color');
    before_control.addEventListener('input', event => {
        let ctx = before_canvas.getContext('2d');
        ctx.fillStyle = before_control.value;
        ctx.fillRect(0, 0, before_canvas.width, before_canvas.height);
        before_canvas.dispatchEvent(new Event('_updated'));
        player.schedule_render();
    });
    {
        let ctx = before_canvas.getContext('2d');
        ctx.fillStyle = before_control.value;
        ctx.fillRect(0, 0, before_canvas.width, before_canvas.height);
    }

    let after_canvas = document.getElementById('after-canvas');
    inject_file_support(after_canvas, file_handler);
    let after_control = document.getElementById('after-color');
    after_control.addEventListener('input', event => {
        let ctx = after_canvas.getContext('2d');
        ctx.fillStyle = after_control.value;
        ctx.fillRect(0, 0, after_canvas.width, after_canvas.height);
        after_canvas.dispatchEvent(new Event('_updated'));
        player.schedule_render();
    });
    {
        let ctx = after_canvas.getContext('2d');
        ctx.fillStyle = after_control.value;
        ctx.fillRect(0, 0, after_canvas.width, after_canvas.height);
    }

    let help_button = document.getElementById('show-help');
    let help = document.getElementById('help');
    help_button.addEventListener('click', e => {
        help.classList.toggle('visible');
    });

    let player_cls;
    const params = new URLSearchParams(location.search);
    if (params.has('force-canvas') || ! canvas.getContext('webgl')) {
        player_cls = WipePlayerCanvas;
    }
    else {
        // FIXME why do i get "exceeded 16 live webgl contexts for this principal"???  can i handle losing context?
        player_cls = WipePlayerGL;
    }
    let player = new player_cls(canvas, mask_canvas, before_canvas, after_canvas);
}


// TODO needs fixing before a real release:
// - i feel like generating should auto-play if you're at the end or something
// - dropping files seems hit or miss wtf
//   - can i restrict to images only via some browser feature?
//   - what happens if i drag in a non-image?
//   - what happens if i drag from another website?
// - allow picking resolution (hoo boy)
//   - should there be a limit?
//   - obvious thing is to use your own screen size, but how does that work?  clever scaling?
//   - hold onto dropped before/after files so we can reread them?
// - allow playing in fullscreen
// - layout is still not IDEAL, but do i care?  i would love to understand what's up with the flexbox.  maybe should show scaled % or something too
// - better error, loading, processing handling
// - wrap this in a namespace or closure or whatever
// - maybe come up with some more patterns so this feels like it's worth the effort??
//
// - fix the fuckin, timing not being right, god, that's supposed to be the whole point
// - finish halo support; canvas and webgl seem to differ a bit
// - also support alpha, at least on the 'after' image
//
// - lol heart preset is still fucked
//
// - support easing function
//
// - release source code!!
//
// - help is a LITTLE ugly and could stand to be inline too i guess
//
// TODO misc:
// - should give all the form controls names, so refresh populates them correctly, sigh
// - indicate if using webgl or canvas?
// - some stats, like how long the generation/preview took, or fps of the playback?
// - need some way of indicating when rows/columns are not remotely proportional
// - also indicate when settings have changed but the wipe hasn't been regenerated yet
// - changing delay shouldn't redraw the preview
//   - ideally, changing other settings wouldn't reroll a random wipe...
// - not sure that i handle rows that don't divide evenly very well yet
// - should including the outer border be optional??
// - allow picking particle size too?  maybe you want, an ellipse, idk
// - make this a generator and yield intermittently so the browser doesn't like, completely freeze, even if that makes it a bit slower overall
//   - i tried this and it became 4x slower (!), may need to consider a web worker or something, idk
// - allow swapping before/after canvases
//   - or maybe this should be a playback mode?  forward, backward, pingpong
// - support reading a black/white image instead of alpha
//
// - do i need shutter if i have reflect?  alternative, should reflect be a slider?
// - support uploading your own grayscale cell pattern?
// - support hex or tri grids?
// - support offsetting every other column or something???  that would be cool with hearts!!
// - check if hi-def masks work with renpy; if not, allow doing grayscale.  or maybe do that anyway
//
// - REALLY gotta fix the max time being wrong because of overlap, oops
// - allow outer edge to exist, optionally?
// - optionally allow disabling cell overlap entirely?
