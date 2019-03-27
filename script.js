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
    uniform vec4 before_color;
    uniform vec4 after_color;
    uniform float t;
    uniform float ramp;

    varying vec2 tex_coords;

    vec4 alpha_composite(vec4 top, vec4 bottom) {
        float alpha = top.a + bottom.a * (1.0 - top.a);
        return vec4((top.rgb * top.a + bottom.rgb * (bottom.a * (1.0 - top.a))) / alpha, alpha);
    }

    void main() {
        vec4 pixel = after_color;
        float discriminator = texture2D(mask, tex_coords).r;
        float scaled_t = t * (1.0 + ramp * 2.0) - ramp;
        float alpha = clamp((scaled_t - discriminator) / ramp + 0.5, 0.0, 1.0);
        pixel.a *= alpha;
        gl_FragColor = alpha_composite(pixel, before_color);
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
        let texture_index = 0;
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

            gl.activeTexture([gl.TEXTURE1, gl.TEXTURE2][uniform.texture_index]);
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
    }
}


// BASE WIPEPLAYER -------------------------------------------------------------

class WipePlayer {
    constructor(canvas, mask_canvas, before_canvas, after_canvas) {
        this.canvas = canvas;
        this.mask_canvas = mask_canvas;
        this.before_canvas = before_canvas;
        this.after_canvas = after_canvas;

        this.t = 0;
        this.ramp = 4/256;
        this.duration = 2;

        this.playing = false;

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

        this.play_pause_button.textContent = '⏸️';
    }

    pause() {
        this.playing = false;

        this.play_pause_button.textContent = '▶️';
    }

    set_time(t) {
        this.t = t;
        this.schedule_render();

        this.time_slider.value = String(t);
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
            this.set_time(1);
            this.pause();
        }
        else if (this.playing) {
            window.requestAnimationFrame(this.render_loop.bind(this));
        }
    }
}


// WEBGL WIPEPLAYER ------------------------------------------------------------

class WipePlayerGL extends WipePlayer {
    constructor(gl, mask_canvas) {
        super(gl.canvas, mask_canvas);

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

        // Create the mask texture
        this.mask_texture = new Texture(gl, mask_canvas);

        // Set up some common drawing stuff
        gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
        gl.clearColor(0, 0, 0, 0);

        gl.useProgram(this.shader.program);
        this.shader.send('mask', this.mask_texture);
        this.shader.send('before_color', [1, 0.5, 0, 1]);
        this.shader.send('after_color', [0, 1, 0.5, 1]);
        this.shader.send('ramp', 4/256);
    }

    set_time(t) {
        this.shader.send('t', t);
        super.set_time(t);
    }

    render() {
        this.scheduled = false;

        const gl = this.gl;
        gl.clear(gl.COLOR_BUFFER_BIT);

        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
}


// CANVAS WIPEPLAYER -----------------------------------------------------------

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
            let alpha = (t - discriminator) / this.ramp + 0.5;
            if (alpha < 0) {
                alpha = 0;
            }
            else if (alpha > 1) {
                alpha = 1;
            }
            // FIXME probably do a real alpha composite
            out_pixels.data[i + 0] = pixels1.data[i + 0] * (1 - alpha) + pixels2.data[i + 0] * alpha;
            out_pixels.data[i + 1] = pixels1.data[i + 1] * (1 - alpha) + pixels2.data[i + 1] * alpha;
            out_pixels.data[i + 2] = pixels1.data[i + 2] * (1 - alpha) + pixels2.data[i + 2] * alpha;
            out_pixels.data[i + 3] = 255;
            continue;

            // FIXME make alpha optional
            // Compute the alpha of the halo such that it's 1.0 when the
            // discriminator matches exactly, and 0.0 just at the end of the ramp
            let halo_alpha = 1.0 - Math.abs(t - discriminator) / ramp;
            if (halo_alpha < 0) {
                halo_alpha = 0;
            }
            else if (halo_alpha > 1) {
                halo_alpha = 1;
            }

            if (alpha <= 0) {
                // Nothing to draw at all
                overlay_pixels.data[i + 3] = 0;
            }
            else if (alpha >= 1) {
                // Full overlay, so do nothing
                ;
            }
            else if (alpha < 0.5) {
                // No overlay, but a halo
                overlay_pixels.data[i + 0] = halo_color[0];
                overlay_pixels.data[i + 1] = halo_color[1];
                overlay_pixels.data[i + 2] = halo_color[2];
                overlay_pixels.data[i + 3] = Math.floor(halo_alpha * 255 + 0.5);
            }
            else {
                // Blend the halo with the overlay
                const overlay_alpha = overlay_pixels.data[i + 3] / 255;
                const blend_alpha = halo_alpha + overlay_alpha * (1 - halo_alpha);
                for (let ch = 0; ch < 3; ch++) {
                    overlay_pixels.data[i + ch] = (halo_color[ch] * halo_alpha + overlay_pixels.data[i + ch] * overlay_alpha * (1 - halo_alpha)) / blend_alpha + 0.5;
                }
                overlay_pixels.data[i + 3] = blend_alpha * 255 + 0.5;
            }
        }
        this.ctx.putImageData(out_pixels, 0, 0);
    }
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


// A "pattern" is the order in which the wipe's cells are revealed.  Each cell
// is associated with a "step", which is an integer starting from zero.  The
// maximum step is given by the max_step() method.
// One of the simplest patterns is the "row" pattern, where each row is
// revealed in order; therefore each cell's step is simply its row index, and
// the max step is one less than the number of rows.
// Note that it's possible to query cells OUTSIDE the grid, in which case the
// resulting step might be less than zero or more than the max step.  This can
// happen if the particle may start outside the mask and expand into it.
class PatternGenerator {
    constructor(row_ct, column_ct) {
        this.row_ct = row_ct;
        this.column_ct = column_ct;
        this.max_step = this._get_max_step();
    }

    _get_max_step() {
        throw new Error("Must define _get_max_step");
    }

    cell(r, c) {
        throw new Error("Must define cell");
    }
}

class RowPattern extends PatternGenerator {
    _get_max_step() {
        return this.row_ct - 1;
    }
    cell(r, c) {
        return r;
    }
}
class ColumnPattern extends PatternGenerator {
    _get_max_step() {
        return this.column_ct - 1;
    }
    cell(r, c) {
        return c;
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




// Note that some of the patterns as exposed in the UI map to several pattern
// generator types, depending on other settings.  This maps UI patterns to the
// controls they rely on, and how those controls affect the choice and
// configuration of generator.
const PATTERN_GENERATORS = {
    // "Wipe" is a straight wipe across in one of the four cardinal directions
    // TODO why doesn't this also include diagonal wipes?  hell, why not arbitrary angle?
    wipe: {
        extra_controls: ['direction'],
        generator: {
            // FIXME how do i make left/right do different things correctly
            right: ColumnPattern,
            left: ColumnPattern,
            down: RowPattern,
            up: RowPattern,
        },
    },
    // "Curtain" expands from two adjacent corners in one of the four cardinal
    // directions; if downwards, it looks like stage curtains closing
    curtain: {
        extra_controls: ['direction'],
        generator: {
            // FIXME how do i make left/right do different things correctly
            right: ColumnCurtainPattern,
            left: ColumnCurtainPattern,
            down: RowCurtainPattern,
            up: RowCurtainPattern,
        },
    },
    // "Shutter" closes from two opposite corners or sides
    shutter: {
        extra_controls: ['direction2'],
        generator: {
            vertical: ColumnShutterPattern,
            horizontal: RowShutterPattern,
            'main-diagonal': MainDiagonalShutterPattern,
            // FIXME others
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
        // FIXME still not sure how to do this
        //generator: SpiralPattern,
    },
    // "Random" is, well, random
    random: {
        // FIXME slightly more complicated
        //generator: RandomPattern,
    },
    // TODO opposite corners too?
    // TODO wipe fall a la doom?
    // TODO random splatters?  not really grid-based at all huh
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

        // Bind some required controls
        this.bind_control('control-rows', 'rows');
        this.bind_control('control-cols', 'columns');
        this.bind_control('control-delay', 'delay');
        this.bind_control('control-pattern', 'pattern');
        // And optional ones
        this.bind_control('control-direction', 'direction', true);
        this.bind_control('control-direction2', 'direction2', true);
        // And generic ones
        // TODO maybe these should be hidden for symmetric ones where they don't apply?
        this.bind_control('control-interlace', 'interlace');
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
                const ctx = this.particle_canvas.getContext('2d');
                const w = this.particle_canvas.width;
                const h = this.particle_canvas.height;
                console.log('ok');
                ctx.clearRect(0, 0, w, h);
                ctx.beginPath();
                const tau = Math.PI * 2;
                // TODO probably use a function dict for this
                if (shape === 'diamond') {
                    ctx.moveTo(0, h/2);
                    ctx.lineTo(w/2, 0);
                    ctx.lineTo(w, h/2);
                    ctx.lineTo(w/2, h);
                }
                else if (shape === 'circle') {
                    ctx.ellipse(w/2, h/2, w/2, h/2, 0, 0, tau);
                }
                else if (shape === 'heart') {
                    ctx.moveTo(0, h/2);
                    ctx.lineTo(w/2, h);
                    ctx.lineTo(w, h/2);
                    ctx.arc(w*3/4, h/4, w/4, tau/8, 4*tau/8, true);
                    ctx.arc(w/4, h/4, w/4, 7*tau/8, 3*tau/8, true);
                }
                else if (shape === 'star') {
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
                }
                ctx.closePath();
                ctx.fill();
            });
        }

        // And of course, bind the button
        document.getElementById('control-generate').addEventListener('click', event => {
            generate_particle_wipe_mask(this.particle_canvas, mask_canvas, this.settings.rows, this.settings.columns, this.settings.delay, this.get_generator());
        });
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
                    control_def.control.parentNode.classList.add('hidden');
                }
            }

            if (generator_def.extra_controls) {
                for (const control_key of generator_def.extra_controls) {
                    this.controls[control_key].control.parentNode.classList.remove('hidden');
                }
            }
        }
    }

    get_generator() {
        const pattern_type = this.settings.pattern;
        const generator_def = PATTERN_GENERATORS[pattern_type];
        const extra_controls = generator_def.extra_controls || [];
        let generator_tree = generator_def.generator;

        for (const key of extra_controls) {
            const value = this.settings[key];
            generator_tree = generator_tree[value];
            if (! generator_tree) {
                throw new Error(`Can't find a generator for ${key} = ${value}`);
            }
        }

        let generator = new generator_tree(this.settings.rows, this.settings.columns);

        // Apply wrappers, if appropriate
        console.log(this.settings);
        // TODO when does interlace apply?
        if (this.settings.interlace > 1) {
            generator = new PatternInterlaced(generator, this.settings.interlace);
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

function init() {
    "use strict";
    let canvas = document.getElementById('canvas');
    let ctx = canvas.getContext('2d');

    let mask_canvas = document.getElementById('mask-canvas');
    let width = canvas.width;
    let height = canvas.height;

    let mask_ctx = mask_canvas.getContext('2d');

    // Populate the mask
    // TODO probably ensure the mask is the same size or whatever
    let particle = document.getElementById('particle');
    //generate_particle_wipe_mask(particle, mask_canvas, 7, 13, 0.0625, 'column');

    let view = new GeneratorView(document.querySelector('#generator .particle'), mask_canvas);

    // Deal with the playback canvases
    // TODO allow dropping images here
    // FIXME extend this to webgl too, allow changing colors, etc.
    let before_canvas = document.getElementById('before-canvas');
    let before_control = document.getElementById('before-color');
    before_control.addEventListener('change', event => {
        let ctx = before_canvas.getContext('2d');
        ctx.fillStyle = before_control.value;
        ctx.fillRect(0, 0, before_canvas.width, before_canvas.height);
        player.schedule_render();
    });
    {
        let ctx = before_canvas.getContext('2d');
        ctx.fillStyle = before_control.value;
        ctx.fillRect(0, 0, before_canvas.width, before_canvas.height);
    }

    let after_canvas = document.getElementById('after-canvas');
    let after_control = document.getElementById('after-color');
    after_control.addEventListener('change', event => {
        let ctx = after_canvas.getContext('2d');
        ctx.fillStyle = after_control.value;
        ctx.fillRect(0, 0, after_canvas.width, after_canvas.height);
        player.schedule_render();
    });
    {
        let ctx = after_canvas.getContext('2d');
        ctx.fillStyle = after_control.value;
        ctx.fillRect(0, 0, after_canvas.width, after_canvas.height);
    }

    let player = new WipePlayerCanvas(canvas, mask_canvas, before_canvas, after_canvas);
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
            // Relative position of the pixel, from -0.5 to 0.5
            // FIXME this is dumb
            let x = (px + 0.5) / (column_width * 3) - 0.5;
            let y = (py + 0.5) / (row_height * 3) - 0.5;

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
                box_scale_row.append(0);
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
                // FIXME oh but what if the gat dang particle is only a single lit
                // pixel in the center, making the distance zero?  it's not ACTUALLY
                // zero because pixels aren't zero-size...  maybe account for this
                // later.
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
    document.body.appendChild(stamp_canvas);

    /*
    for row in box_scales:
        for scale in row:
            print(f"{scale:5.2f}", end=' ')
            #print(' .:*@#'[int(scale / max_scale * 5.999)], end='')
        print()

    print("MAX SCALE:", max_scale)
    print()
    */

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

    // FIXME i realize, all of a sudden, that in cases like squares, you likely
    // don't WANT them to keep growing outside their box.  hmm
    let i = 0;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const col = Math.floor(x / column_width);
            const row = Math.floor(y / row_height);
            const step = generator.cell(row, col);

            const start_time = step * delay;

            // FIXME suspect there'll be a problem here with indexing from 0 vs 1
            const bx = x % column_width;
            const by = y % row_height;

            let scales = [];
            let scale_steps = [];
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
            const value = time / total_time;
            const pixel = Math.floor(value * 255 + 0.5);

            pixels.data[i + 0] = pixel;
            pixels.data[i + 1] = pixel;
            pixels.data[i + 2] = pixel;
            pixels.data[i + 3] = 255;
            i += 4;
        }
    }

    ctx.putImageData(pixels, 0, 0);
}


// TODO:
// - need some way of indicating when rows/columns are not remotely proportional
// - not sure that i handle rows that don't divide evenly very well yet
// - should including the outer border be optional??
// - obviously support dragging files in
// - support hex or tri grids?
// - support offsetting every other column or something???  that would be cool with hearts
// - support (both generation and playback) higher-definition masks using all three channels.  actually this might even be compatible since the extra channels would just be extra detail?  depends how ren'py does it, does it just read the red channel?
