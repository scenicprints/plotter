// CR-6 SE pen plotter holder, v1
// Two 3mm steel guide rods, sprung carriage, per-pen sleeves.
// Mount-plate hole spacing is a PLACEHOLDER until the bracket is measured.
// All dims in mm.

$fn = 48;

// ---------------- parameters ----------------
rod_d          = 3.0;    // steel rod diameter
rod_len        = 45;     // rod length
rod_spacing    = 40;     // centre-to-centre
rod_clear      = 0.35;   // carriage bore clearance over rod
rod_press      = 0.15;   // press-fit undersize in plates

plate_w        = 58;     // x
plate_d        = 20;     // y
top_t          = 10;     // top plate thickness
bot_t          = 6;      // bottom plate thickness

carriage_h     = 22;
sleeve_bore    = 12;     // carriage centre bore, all sleeves share this OD
pen_hole       = 15;     // pen clearance through both plates

spring_od      = 5.2;    // click-pen spring
spring_wire    = 0.45;
spring_seat_d  = 7.5;    // locating counterbore
spring_seat_dp = 2.5;

wall_t         = 6;      // back wall that meets the bracket
wall_h         = 48;
mount_hole_d   = 4.4;    // M4 clearance  (PLACEHOLDER)
mount_spacing  = 24;     // hole spacing  (PLACEHOLDER - measure bracket)
mount_z        = 30;     // hole height   (PLACEHOLDER - measure bracket)

clamp_slit     = 2.0;
clamp_hole_d   = 3.4;    // M3 clearance

// BIC Cristal sleeve
bic_barrel     = 9.0;    // hex barrel across corners ~8.9
sleeve_len     = 30;
flange_d       = 15;
flange_t       = 2;

// derived
rx = rod_spacing/2;
carriage_z0 = bot_t;                 // carriage rests on bottom plate
top_z0 = rod_len + 1 - 8 + 0;        // top plate underside so rods socket 8mm
// keep simple: place explicitly
top_bottom = 38;                     // underside of top plate
travel = top_bottom - (carriage_z0 + carriage_h);   // = 10mm free travel

// ---------------- parts ----------------

module rod() color("silver") cylinder(d=rod_d, h=rod_len);

module spring(h) {
    color([0.95, 0.62, 0.12])
    linear_extrude(height=h, twist=-360*6, slices=120)
        translate([spring_od/2 - spring_wire/2, 0]) circle(d=spring_wire);
}

module bottom_plate() color([0.62,0.62,0.62]) difference() {
    translate([-plate_w/2, -plate_d/2, 0]) cube([plate_w, plate_d, bot_t]);
    // rod sockets (blind, press fit)
    for (s=[-1,1]) translate([s*rx, 0, 1]) cylinder(d=rod_d-rod_press, h=bot_t);
    // pen clearance
    cylinder(d=pen_hole, h=3*bot_t, center=true);
}

module top_plate() color([0.62,0.62,0.62]) difference() {
    union() {
        translate([-plate_w/2, -plate_d/2, top_bottom]) cube([plate_w, plate_d, top_t]);
        // back wall down to bottom, meets the bracket face
        translate([-plate_w/2, plate_d/2, 0]) cube([plate_w, wall_t, wall_h]);
    }
    // rod sockets, blind from below
    for (s=[-1,1]) translate([s*rx, 0, top_bottom]) cylinder(d=rod_d-rod_press, h=8);
    // pen clearance
    translate([0,0,top_bottom-1]) cylinder(d=pen_hole, h=top_t+2);
    // spring locating counterbores on the underside
    for (s=[-1,1]) translate([s*rx, 0, top_bottom-0.01]) cylinder(d=spring_seat_d, h=spring_seat_dp);
    // bracket mount holes (PLACEHOLDER spacing)
    for (s=[-1,1]) translate([s*mount_spacing/2, plate_d/2-1, mount_z])
        rotate([-90,0,0]) cylinder(d=mount_hole_d, h=wall_t+2);
}

module carriage() color([0.55,0.50,0.85]) difference() {
    translate([-plate_w/2, -plate_d/2, carriage_z0]) cube([plate_w, plate_d-0.5, carriage_h]);
    // rod bores
    for (s=[-1,1]) translate([s*rx, 0, carriage_z0-1]) cylinder(d=rod_d+rod_clear, h=carriage_h+2);
    // spring seats on top face
    for (s=[-1,1]) translate([s*rx, 0, carriage_z0+carriage_h-spring_seat_dp]) cylinder(d=spring_seat_d, h=spring_seat_dp+1);
    // sleeve bore
    translate([0,0,carriage_z0-1]) cylinder(d=sleeve_bore, h=carriage_h+2);
    // clamp slit, front face to bore
    translate([-clamp_slit/2, -plate_d/2-1, carriage_z0-1]) cube([clamp_slit, plate_d/2+1, carriage_h+2]);
    // M3 clamp screw crossing the slit
    translate([-plate_w/2-1, -7.5, carriage_z0+carriage_h/2]) rotate([0,90,0]) cylinder(d=clamp_hole_d, h=plate_w+2);
}

module sleeve() color([0.10,0.62,0.55]) difference() {
    union() {
        cylinder(d=sleeve_bore-0.15, h=sleeve_len);
        translate([0,0,sleeve_len-flange_t]) cylinder(d=flange_d, h=flange_t);
    }
    translate([0,0,-1]) cylinder(d=bic_barrel, h=sleeve_len+2);
    translate([-0.75, 0, -1]) cube([1.5, flange_d, sleeve_len+2]);
}

module pen_mock() color([0.22,0.45,0.85,0.85]) {
    translate([0,0,-4]) cylinder(d=8.5, h=118);
    translate([0,0,-14]) cylinder(d1=1.2, d2=8.5, h=10);
}

// ---------------- assembly ----------------
module assembly() {
    bottom_plate();
    top_plate();
    for (s=[-1,1]) translate([s*rx, 0, 1]) rod();
    carriage();
    // springs sit between carriage top and top plate underside
    for (s=[-1,1]) translate([s*rx, 0, carriage_z0+carriage_h-spring_seat_dp]) spring(top_bottom - (carriage_z0+carriage_h) + 2*spring_seat_dp);
    // sleeve in carriage, flange resting on carriage top
    translate([0,0,carriage_z0+carriage_h-sleeve_len]) sleeve();
    pen_mock();
}

part = "assembly"; // assembly | top | bottom | carriage | sleeve

if (part == "assembly") assembly();
if (part == "top")      top_plate();
if (part == "bottom")   bottom_plate();
if (part == "carriage") carriage();
if (part == "sleeve")   sleeve();
