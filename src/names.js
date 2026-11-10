'use strict';
// Common first names and surnames in the United States (no one in particular), for the retraining
// export (src/training.js): a capitalized word at the start of a sentence or in a headline is marked as
// a possible name when it is one of these, or when it isn't an everyday word (not in the model's
// vocabulary). Names that are also everyday words (Will, Grace, Hope, Chase…) are left out: at the
// start of a sentence they are more often the word.
const FIRST = `
aaliyah aaron abigail adam adrian aiden aisha alan alejandro alex alexa alexander alexandra alexis alice alicia alison allison alyssa amanda amber amelia amy ana andre andrea andrew angel angela
angelica anna anne annie anthony antonio ariana arianna arthur ashley audrey austin ava avery bailey barbara benjamin bethany betty beverly blake brandon brenda brian brianna brittany brooke
bryan caleb cameron camila carlos carmen caroline carter catherine cecilia charles charlie charlotte chelsea cheryl chloe chris christian christina christine christopher cindy claire
clara cody colin connor courtney craig cristina crystal cynthia daisy dakota dale dana daniel daniela danielle darius darnell darren david debbie deborah denise derek destiny devin diana
diane diego dominic donald donna dorothy douglas dylan edward eduardo elena eli elijah elizabeth ella ellie emily emma eric erica erik erin esther ethan eva evan evelyn fatima felix fernando
francisco gabriel gabriela gabriella gail gary george gerald gina gloria gregory hailey haley hannah harold harper heather helen henry hector isaac isabel isabella isaiah ivan jacob jacqueline
jada jaime jake jamal james jamie jane janet janice jared jasmine jason javier jayla jeffrey jenna jennifer jeremiah jeremy jerry jesse jessica jesus jillian joan joanna jocelyn joe joel
john johnny jonathan jordan jorge jose joseph joshua josiah joyce juan judith julia julian juliana julie justin kaitlyn karen katelyn katherine kathleen kathryn kathy katie kayla keisha keith
kelly kelsey kenneth kevin khalil kimberly kristen kristin kyle kylie lamar larry latisha laura lauren layla leah leonardo leslie liam lillian linda lindsey logan lori louis lucas lucia
luis luke lydia mackenzie madeline madison makayla malik manuel marcus margaret maria mariah marie marilyn mario marisol marissa martha martin mary mason matthew megan melanie melissa mia micah
michael michelle miguel mikayla miranda molly monica morgan nancy naomi natalie nathan nathaniel nevaeh nicholas nicole noah nora oliver olivia omar oscar owen pablo pamela patricia patrick
paul paula peter rachel rafael ramon randy raquel rebecca regina riley robert roberto rodney ronald rosa ruth ryan sabrina samantha samuel sandra sara sarah savannah scott sean sebastian
sergio shannon sharon shawn sheila shirley sierra sofia sophia stephanie stephen steven susan sydney tamara tanya tara taylor teresa terrence theresa thomas tiffany timothy tina tony
travis trevor tyler valerie vanessa veronica vicky victor victoria vincent virginia wayne wendy william wyatt xavier yolanda yvonne zachary zoe
`;
const LAST = `
adams alexander allen alvarez anderson bailey baker barnes bennett brooks bryant butler campbell carter castillo castro chavez chen clark coleman collins cooper cox cruz davis diaz
edwards evans flores foster garcia gomez gonzales gonzalez gordon graham griffin gutierrez harris hayes henderson hernandez hughes jackson james jenkins jimenez johnson jones jordan
kelly kennedy kim lee lewis lopez martin martinez mendoza miller mitchell moore morales morgan morris murphy myers nelson nguyen ortiz parker patel patterson perez perry peterson
phillips powell ramirez ramos reed reyes richardson rivera roberts robinson rodriguez rogers ross ruiz russell sanchez sanders scott simmons smith stewart sullivan taylor thomas thompson torres
turner walker wallace washington watson williams wilson wright
`;
const NAMES = new Set(`${FIRST} ${LAST}`.split(/\s+/).filter(Boolean));
module.exports = { NAMES };
